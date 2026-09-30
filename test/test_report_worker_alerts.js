/* The report Worker's alert cap and ordering, under concurrency and under a flood of forged
 * reports. Same SQLite stand-in for D1 as test_report_worker.js. Each block failed before its fix.
 *
 * D1 runs one statement at a time, and so does this stand-in, but every `await` is a point where
 * another request's work can run. That is enough to interleave "is there room?" and "spend it". */
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
        first: async function () { var p = db.prepare(sql); return p.get.apply(p, args) || null; },
        all: async function () { var p = db.prepare(sql); return { results: p.all.apply(p, args) }; },
        run: async function () { var p = db.prepare(sql); return { meta: { changes: p.run.apply(p, args).changes } }; }
      };
      return st;
    }
  };
}

(async function () {
  var M = await import('../report-worker/worker.mjs');
  var crypto = require('crypto');
  var NOW = Date.parse('2026-10-05T15:00:00Z');
  var setup = function () {
    var e = { DB: d1(), sent: [], ok: true, waits: [] };
    e.send = async function (a) { if (e.ok) e.sent.push(a); return e.ok; };
    e.ctx = { waitUntil: function (p) { e.waits.push(p); } };
    return e;
  };
  var failed = [];
  var block = async function (name, fn) { try { await fn(); } catch (e) { failed.push(name + ': ' + String(e.message).split(String.fromCharCode(10))[0]); } };
  var n = 0;
  var report = function (where, install) {
    return { schema: 1, install: install || crypto.randomUUID(), version: '18c3071', host: 'claude', node: 20, os: 'darwin',
      date: '2026-10-05', id: (++n).toString(16).padStart(16, '0'), kind: 'run_failed', stage: 'runner', error: 'SyntaxError', where: where };
  };
  var post = async function (e, r, now) {
    var res = await M.receive(new Request('https://x.workers.dev/report', { method: 'POST', body: JSON.stringify(r) }), e, e.ctx, now || NOW);
    return res.status;
  };
  var settle = async function (e) { while (e.waits.length) await Promise.all(e.waits.splice(0)); };
  var spent = function (e) { var r = e.DB.raw.prepare('SELECT n FROM alerts').get(); return r ? r.n : 0; };

  await block('the cap of ten a day holds when reports arrive at once', async function () {
    /* ---- the cap of ten a day holds when reports arrive at once ---- */
    var e1 = setup();
    await Promise.all(Array.from({ length: 30 }, function (_, i) { return post(e1, report(['src/loops.js:' + (100 + i)])); }));
    await settle(e1);
    assert.strictEqual(e1.sent.length, 10, 'ten alerts a day, however many arrive together: ' + e1.sent.length);
    assert.strictEqual(spent(e1), 10, 'and the count says so');
    assert.strictEqual(e1.DB.raw.prepare('SELECT COUNT(*) AS n FROM reports WHERE alerted = 0').get().n, 20, 'the rest wait for tomorrow');

  });

  await block('one report is alerted once, even when several requests find it at the same moment', async function () {
    /* ---- one report is alerted once, even when several requests find it at the same moment ---- */
    var e2 = setup();
    await Promise.all(Array.from({ length: 8 }, function () { return post(e2, report(['src/store.js:48'])); }));
    await settle(e2);
    var ids = [];
    e2.sent.forEach(function (a) { (a.body.match(/`[0-9a-f]{16}`/g) || []).forEach(function (x) { ids.push(x); }); });
    assert.strictEqual(new Set(ids).size, ids.length, 'no report id appears in two alerts: ' + ids.length + ' listed, ' + new Set(ids).size + ' distinct');
    assert.strictEqual(new Set(ids).size, 8, 'and every report is in one');
    assert.strictEqual(e2.DB.raw.prepare('SELECT COUNT(*) AS n FROM reports WHERE alerted = 0').get().n, 0);

  });

  await block('a failed send gives its place back, and its rows', async function () {
    /* ---- a failed send gives its place back, and its rows ---- */
    var e3 = setup();
    e3.ok = false;
    await post(e3, report(['src/ledger.js:9']));
    await settle(e3);
    assert.strictEqual(spent(e3), 0, 'a refused alert costs nothing against the cap');
    assert.strictEqual(e3.DB.raw.prepare('SELECT COUNT(*) AS n FROM reports WHERE alerted = 0').get().n, 1, 'and stays unalerted for the cron');
    e3.ok = true;
    await M.daily(e3, NOW + 864e5);
    assert.strictEqual(e3.sent.length, 1);
    assert.strictEqual(e3.DB.raw.prepare('SELECT COUNT(*) AS n FROM reports WHERE alerted = 0').get().n, 0);

  });

  await block('a claim left by a run that died is released by the cron', async function () {
    /* ---- a claim left by a run that died is released by the cron ---- */
    var e4 = setup();
    await post(e4, report(['src/loops.js:7']));
    await settle(e4);
    e4.DB.raw.exec('DELETE FROM alerts');
    e4.DB.raw.exec("INSERT INTO reports (install, id, kind, received, day, body, sig, alerted) VALUES ('i', 'stuck', 'run_failed', '2026-10-05T10:00:00.000Z', '2026-10-05', '{\"where\":[]}', 'runner|TypeError|-', 424242)");
    await M.daily(e4, NOW + 864e5);
    assert.ok(e4.sent.some(function (a) { return /TypeError/.test(a.title); }), 'a claimed-and-abandoned report is alerted by the next cron');

  });

  await block('forged reports queue behind nothing: a real failure is not starved by an older backlog', async function () {
    /* ---- forged reports queue behind nothing: a real failure is not starved by an older backlog ---- */
    var e5 = setup();
    var forged = [];
    for (var i = 0; i < 6; i++) forged.push(crypto.randomUUID());
    for (var k = 0; k < 300; k++) { await post(e5, report(['src/loops.js:' + (1000 + k)], forged[k % 6]), NOW); await settle(e5); }
    assert.strictEqual(e5.sent.length, 10, 'day one: the flood spends the ten');
    var real = report(['src/digest.js:77']);
    real.error = 'TypeError';
    await post(e5, real, NOW + 3600e3);
    await settle(e5);
    var before = e5.sent.length;
    await M.daily(e5, NOW + 864e5);
    var got = e5.sent.slice(before).filter(function (a) { return /TypeError/.test(a.title); });
    assert.strictEqual(got.length, 1, 'the next day the newest failure is alerted first, not queued behind 290 older forged ones');

  });
  if (failed.length) { failed.forEach(function (f) { console.error('FAIL ' + f); }); process.exit(1); }
  console.log('report worker alerts: OK');
})().catch(function (e) { console.error(e); process.exit(1); });
