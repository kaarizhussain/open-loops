/* The report server, run in Node against SQLite standing in for D1.
 *
 * What it accepts, that it stores nothing about the request, that each event is stored
 * once, and when it alerts. Alerts are captured instead of sent to GitHub.
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var { DatabaseSync } = require('node:sqlite');

var W = path.join(__dirname, '..', 'report-worker');

function d1() {
  var db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(W, 'schema.sql'), 'utf8'));
  return {
    raw: db,
    prepare: function (sql) {
      var args = [];
      var st = {
        bind: function () { args = [].slice.call(arguments); return st; },
        first: async function () { return db.prepare(sql).get.apply(db.prepare(sql), args) || null; },
        all: async function () { var p = db.prepare(sql); return { results: p.all.apply(p, args) }; },
        run: async function () { var p = db.prepare(sql); return { meta: { changes: p.run.apply(p, args).changes } }; }
      };
      return st;
    }
  };
}

/* ------------------ nothing about the request is kept or logged ------------------ */
var src = fs.readFileSync(path.join(W, 'worker.mjs'), 'utf8');
assert.ok(!/console\./.test(src), 'the Worker never logs');
assert.ok(!/headers\.get|cf-connecting-ip|x-forwarded-for|req\.cf\b|request\.cf\b/i.test(src),
  'the Worker never reads request headers or the cf object');
var cfgText = fs.readFileSync(path.join(W, 'wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/mg, '');
var wr = JSON.parse(cfgText);
assert.deepStrictEqual(wr.observability, { enabled: false, logs: { enabled: false, invocation_logs: false },
  traces: { enabled: false } }, 'Workers Logs are off, every part, explicitly');
assert.strictEqual(wr.preview_urls, false);
assert.ok(!wr.tail_consumers && !wr.logpush, 'no Tail Worker, no Logpush');
assert.ok(!/ip|header|agent/i.test(fs.readFileSync(path.join(W, 'schema.sql'), 'utf8').replace(/^--.*$/mg, '')),
  'no column for request metadata');

(async function () {
  var M = await import('../report-worker/worker.mjs');
  var db = d1(), sent = [], sendOk = true, waits = [];
  var env = { DB: db, send: async function (a) { if (sendOk) sent.push(a); return sendOk; } };
  var ctx = { waitUntil: function (p) { waits.push(p); } };
  var NOW = Date.parse('2026-10-05T15:00:00Z');       // a Monday
  var post = async function (route, body, now) {
    var res = await M.receive(new Request('https://x.workers.dev' + route, {
      method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'cf-connecting-ip': '203.0.113.9', 'user-agent': 'CANARY' } }), env, ctx, now || NOW);
    await Promise.all(waits.splice(0));
    return res.status;
  };
  var base = { schema: 1, install: '3f9c0a4e-8b1d-4c2e-9f00-1a2b3c4d5e6f', version: '18c3071',
    host: 'claude', node: 20, os: 'darwin', date: '2026-10-05' };
  var n = 0;
  var rep = function (fields) { return Object.assign({ id: (++n).toString(16).padStart(16, '0') }, base, fields); };
  var fail = function (where) { return rep({ kind: 'run_failed', stage: 'runner', error: 'SyntaxError', where: where }); };

  /* ------------------------------ accepting ------------------------------ */
  assert.strictEqual(await post('/report', Object.assign(fail(['slack-run.js:303']), { note: 'x' })), 400, 'extra field');
  assert.strictEqual(await post('/report', 'not json'), 400);
  assert.strictEqual(await post('/report', 'x'.repeat(1025)), 413, 'over 1 KB');
  assert.strictEqual(await post('/nope', fail([])), 404);
  assert.strictEqual(await post('/example', fail([])), 400, 'a report is not an example');

  var first = fail(['slack-run.js:303', 'src/loops.js:12']);
  assert.strictEqual(await post('/report', first), 200);
  assert.strictEqual(await post('/report', first), 200, 'a repeat is accepted');
  assert.strictEqual(db.raw.prepare('SELECT COUNT(*) AS n FROM reports').get().n, 1, 'and stored once');
  var stored = db.raw.prepare('SELECT * FROM reports').get();
  assert.ok(!/203\.0\.113\.9|CANARY/.test(JSON.stringify(stored)), 'nothing from the request is stored');

  /* ------------------------------ alerting ------------------------------ */
  assert.strictEqual(sent.length, 1, 'a new failure alerts at once');
  var a = sent[0];
  assert.ok(/^k-[0-9a-f]{12}$/.test(a.key) && a.labels === 'run-failed,new');
  assert.ok(!/3f9c0a4e/.test(JSON.stringify(a)), 'an alert never carries an install id');
  assert.ok(/^New failure/.test(a.body), a.body);

  assert.strictEqual(await post('/report', fail(['slack-run.js:303'])), 200);
  assert.strictEqual(sent.length, 2, 'the same signature again alerts again');
  assert.strictEqual(sent[1].key, a.key, 'onto the same issue');
  assert.ok(/^Seen again — 1 report since the last alert; 2 in all from 1 install\./.test(sent[1].body), sent[1].body);

  sendOk = false;
  assert.strictEqual(await post('/report', fail(['src/store.js:48'])), 200, 'a failed alert does not fail the report');
  assert.strictEqual(db.raw.prepare('SELECT COUNT(*) AS n FROM reports WHERE alerted = 0').get().n, 1, 'left unalerted');
  sendOk = true;
  await M.daily(env, NOW + 864e5);
  assert.strictEqual(sent.length, 3, 'the daily cron retries it');
  assert.strictEqual(db.raw.prepare('SELECT COUNT(*) AS n FROM reports WHERE alerted = 0').get().n, 0);

  // At most ten alerts a day; the rest wait.
  var before = sent.length;
  for (var i = 0; i < 12; i++) await post('/report', fail(['src/loops.js:' + (100 + i)]), NOW + 2 * 864e5);
  assert.strictEqual(sent.length - before, 10, 'ten a day');
  assert.strictEqual(db.raw.prepare('SELECT COUNT(*) AS n FROM reports WHERE alerted = 0').get().n, 2);

  // Fifty reports per install per day.
  var capDay = NOW - 10 * 864e5, codes = [];
  for (var j = 0; j < 51; j++) codes.push(await post('/report', rep({ kind: 'item_missed', sampled: 5, missed: 0 }), capDay));
  assert.strictEqual(codes.filter(function (c) { return c === 429; }).length, 1, 'the 51st is refused');

  /* ------------------ limits that hold against rotating install ids ------------------ */
  var fresh = function (fields) { return Object.assign(rep(fields), { install: require('crypto').randomUUID() }); };
  var gday = NOW - 30 * 864e5, gd = new Date(gday).toISOString().slice(0, 10);
  var ins = db.raw.prepare("INSERT INTO reports (install, id, kind, received, day, body) VALUES (?, ?, 'item_missed', ?, ?, '{}')");
  for (var g = 0; g < 1999; g++) ins.run('filler-' + g, 'f' + g, new Date(gday).toISOString(), gd);
  assert.strictEqual(await post('/report', fresh({ kind: 'item_missed', sampled: 5, missed: 0 }), gday), 200, 'the 2000th of the day is taken');
  assert.strictEqual(await post('/report', fresh({ kind: 'item_missed', sampled: 5, missed: 0 }), gday), 503,
    'past the global daily total, even from a new install id — and 503, so it is retried, not dropped');
  db.raw.exec("DELETE FROM reports WHERE day = '" + gd + "'");

  /* Concurrent, which is how a flood arrives. Counting first and inserting after let every
     request in flight read the same count and all get in; the check is now part of the
     insert. Five places left, twenty senders at once, twenty install ids: five stored. */
  for (var h = 0; h < 1995; h++) ins.run('filler-' + h, 'f' + h, new Date(gday).toISOString(), gd);
  var burst = await Promise.all(Array.from({ length: 20 }, function () {
    return post('/report', fresh({ kind: 'item_missed', sampled: 5, missed: 0 }), gday);
  }));
  assert.strictEqual(burst.filter(function (c) { return c === 200; }).length, 5, 'exactly the places left: ' + burst.join(' '));
  assert.strictEqual(burst.filter(function (c) { return c === 503; }).length, 15);
  assert.strictEqual(db.raw.prepare('SELECT COUNT(*) AS n FROM reports WHERE day = ?').get(gd).n, 2000, 'never past the cap');
  db.raw.exec("DELETE FROM reports WHERE day = '" + gd + "'");

  // The same for one install's own cap: sixty at once from one id, fifty stored.
  var one = require('crypto').randomUUID();
  var own = await Promise.all(Array.from({ length: 60 }, function () {
    return post('/report', Object.assign(rep({ kind: 'item_missed', sampled: 5, missed: 0 }), { install: one }), gday);
  }));
  assert.strictEqual(own.filter(function (c) { return c === 200; }).length, 50, own.join(' '));
  assert.strictEqual(own.filter(function (c) { return c === 429; }).length, 10);
  // A repeat is still a repeat, not a refusal, when the cap is full.
  var dupOf = JSON.parse(db.raw.prepare('SELECT body FROM reports WHERE install = ? LIMIT 1').get(one).body);
  assert.strictEqual(await post('/report', dupOf, gday), 200, 'a duplicate of a stored report is accepted, not capped');
  db.raw.exec("DELETE FROM reports WHERE day = '" + gd + "'");

  /* ------------------------------ examples ------------------------------ */
  var ex = { schema: 1, install: base.install, id: 'e0000000000000e1', kind: 'example', version: '18c3071',
    date: '2026-10-05', signal: 'owed_to_us', first_seen: '2026-10-02', text: 'We will send the MSA Friday.' };
  before = sent.length;
  assert.strictEqual(await post('/example', ex, NOW + 4 * 864e5), 200);
  assert.strictEqual(sent.length - before, 1, 'an example alerts');
  assert.ok(sent[sent.length - 1].body.indexOf('MSA') === -1, 'without its text');

  /* ------------------------------ weekly ------------------------------ */
  var mon = Date.parse('2026-10-12T13:17:00Z');
  await post('/report', rep({ kind: 'item_wrong', signal: 'owed_to_us', age_days: 1, listed: 14, date: '2026-10-09' }), Date.parse('2026-10-09T12:00:00Z'));
  await post('/report', rep({ kind: 'item_wrong', signal: 'owed_to_us', age_days: 3, listed: 9, date: '2026-10-10' }), Date.parse('2026-10-10T12:00:00Z'));
  await post('/report', rep({ kind: 'item_wrong', signal: 'unanswered_ask', age_days: 0, listed: 9, date: '2026-10-10' }), Date.parse('2026-10-10T12:00:00Z'));
  await post('/report', rep({ kind: 'item_missed', sampled: 5, missed: 2, date: '2026-10-11' }), Date.parse('2026-10-11T12:00:00Z'));
  before = sent.length;
  await M.daily(env, mon);
  var wk = sent.slice(before).filter(function (s) { return s.labels === 'accuracy,new'; })[0];
  assert.ok(wk, 'Monday brings the weekly summary');
  assert.ok(/\| `owed_to_us` \| 2 \| 1 \|/.test(wk.body) && /\| `unanswered_ask` \| 1 \| 1 \|/.test(wk.body), wk.body);
  assert.ok(/Spot checks answered: 1, with 2 messages marked missed/.test(wk.body), wk.body);
  assert.ok(!/%|rate|proportion/i.test(wk.body), 'counts only — no proportion without a denominator');
  before = sent.length;
  await M.daily(env, mon + 3600e3);
  assert.strictEqual(sent.length, before, 'once per week, even if the cron runs twice');

  /* ------------------------------ retention ------------------------------ */
  await M.daily(env, mon + 88 * 864e5);   // the 10-11 report is 89 days old
  assert.ok(db.raw.prepare('SELECT COUNT(*) AS n FROM reports').get().n > 0, 'kept within 90 days');
  await M.daily(env, mon + 91 * 864e5);
  assert.strictEqual(db.raw.prepare('SELECT COUNT(*) AS n FROM reports').get().n, 0, 'gone after 90 days');
  assert.strictEqual(db.raw.prepare('SELECT COUNT(*) AS n FROM examples').get().n, 0);

  /* ------------------ the real GitHub call, with fetch stubbed ------------------
   * Everything above replaces it. A secret stored as one stray keystroke (2026-09-30) went
   * unnoticed because of that: logging is off, so a refused alert must leave its own trace. */
  var real = global.fetch, calls = [];
  var ghEnv = function (token, status, text) {
    global.fetch = async function (url, init) { calls.push({ url: url, init: init }); return new Response(text || null, { status: status }); };
    return { DB: d1(), GITHUB_TOKEN: token };
  };
  var genv = ghEnv('  github_pat_ABC123_def  ' + String.fromCharCode(10), 204);
  await M.receive(new Request('https://x.workers.dev/report', { method: 'POST', body: JSON.stringify(fail(['src/ledger.js:9'])) }),
    genv, ctx, NOW);
  await Promise.all(waits.splice(0));
  assert.strictEqual(calls[0].url, 'https://api.github.com/repos/kaarizhussain/open-loops-reports/dispatches');
  assert.strictEqual(calls[0].init.headers.authorization, 'Bearer github_pat_ABC123_def', 'the token is trimmed');
  assert.strictEqual(JSON.parse(calls[0].init.body).event_type, 'open-loops-alert');
  assert.strictEqual(genv.DB.raw.prepare('SELECT COUNT(*) AS n FROM alert_failures').get().n, 0, 'a 204 is not a failure');
  assert.strictEqual(genv.DB.raw.prepare('SELECT alerted FROM reports').get().alerted, 1);

  genv = ghEnv(String.fromCharCode(0x16), 401, '{"message":"Bad credentials"}');
  await M.receive(new Request('https://x.workers.dev/report', { method: 'POST', body: JSON.stringify(fail(['src/ledger.js:9'])) }),
    genv, ctx, NOW);
  await Promise.all(waits.splice(0));
  var f1 = genv.DB.raw.prepare('SELECT * FROM alert_failures').get();
  assert.strictEqual(f1.status, 401);
  assert.strictEqual(f1.detail, 'stored GITHUB_TOKEN is not a GitHub token (1 characters); {"message":"Bad credentials"}');
  assert.strictEqual(genv.DB.raw.prepare('SELECT alerted FROM reports').get().alerted, 0, 'left for the retry');
  global.fetch = real;

  console.log('report worker: OK');
})().catch(function (e) { console.error(e); process.exit(1); });
