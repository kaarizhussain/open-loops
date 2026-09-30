/* Diagnostic reports, sender side: what is queued, what is sent, and what never leaves.
 *
 * The canary test is the one that matters. Every place real data could come from — message
 * text, display names, emails, Slack ids, channel names, the config's path, an error's
 * message — carries the word CANARY. Then every path that queues or sends a report runs,
 * and neither the outbox nor a single byte posted may contain it.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var http = require('http');
var { main, queueCrash } = require('../slack-run.js');
var D = require('../src/diagnostics.js');
var outbox = require('../src/outbox.js');
var report = require('../tools/report.js');

var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'CANARYPATH-'));
var cfgPath = path.join(dir, 'openloops.config.json');
var ledger = path.join(dir, 'ledger.json');
var ME = 'canary.you@canary.example';

var at = function (y, mo, d, h) { return (Date.UTC(y, mo - 1, d, h) / 1000).toFixed(6); };
var msg = function (name, email, uid, ts, body) {
  return ['=== Message from ' + name + ' <' + email + '> (' + uid + ') at ' + ts + ' UTC ===',
          'Message TS: ' + ts, body].join('\n');
};
var me = function (ts, body) { return msg('Canary Reader', ME, 'UCANARY001', ts, body); };
var them = function (ts, body) { return msg('Canary Person', 'canary.them@canary.example', 'UCANARY002', ts, body); };

var baseCfg = { you: ME, tzOffset: 0, spotCheck: 3, ledger: ledger };
var writeCfg = function (extra) { fs.writeFileSync(cfgPath, JSON.stringify(Object.assign({}, baseCfg, extra || {}))); };
var input = function (today, dm) {
  var p = path.join(dir, 'in.json');
  fs.writeFileSync(p, JSON.stringify({ today: today, conversations: [{ channel: '#canary-deals', members: [], text: [
    them(at(2026, 8, 20, 10), "CANARYTEXT we'll get the revised contract back to you Friday Aug 28."),
    me(at(2026, 8, 25, 11), "I'll put together the CANARYTEXT scope doc and send it Wednesday."),
    me(at(2026, 8, 28, 10), 'The CANARYTEXT vendor call went fine, nothing blocking on our side.'),
    me(at(2026, 8, 28, 11), 'CANARYTEXT numbers are up 4% quarter on quarter, worth a mention.'),
    me(at(2026, 8, 28, 12), 'Reminder: CANARYTEXT office is closed Monday for the holiday.'),
    me(at(2026, 8, 28, 13), 'CANARYTEXT docs are updated if anyone needs the new endpoints.')
  ].join('\n') }], dm: { channel: 'DCANARY001', text: dm || '' } }));
  return p;
};
var run = function (today, dm) { return main([input(today, dm), '--config', cfgPath]); };
var queued = function () { return outbox.read(dir).map(function (e) { return e.report; }); };
var noCanary = function (s, what) {
  assert.ok(!/canary/i.test(s), what + ' leaked something marked CANARY:\n' + s);
};
var keysOf = function (r) { return Object.keys(r).sort().join(','); };
var COMMON = 'date,host,id,install,kind,node,os,schema,version';

/* ------------------------------ the schema ------------------------------ */
var ok = { schema: 1, install: '3f9c0a4e-8b1d-4c2e-9f00-1a2b3c4d5e6f', id: 'a41be09c2d7f5e10',
  kind: 'item_wrong', version: '18c3071', host: 'claude', node: 20, os: 'darwin', date: '2026-10-03',
  signal: 'owed_to_us', age_days: 1, listed: 14 };
assert.ok(D.exact(ok), 'a valid report passes');
assert.ok(!D.exact(Object.assign({ note: 'x' }, ok)), 'an extra field fails exact');
assert.deepStrictEqual(D.clean(Object.assign({ note: 'x' }, ok)), ok, 'and clean drops it');
assert.strictEqual(D.clean(Object.assign({}, ok, { signal: 'CANARY' })), null, 'a value outside the enum fails');
assert.strictEqual(D.clean(Object.assign({}, ok, { listed: 100 })), null, 'an integer out of range fails');
assert.deepStrictEqual(D.frames([
  'Error: CANARYMSG',
  '    at x (C:\\Users\\canary\\CANARYPATH\\checkout\\src\\loops.js:412:9)',
  '    at y (/home/canary/checkout/slack-run.js:303:15)',
  '    at z (/home/canary/CANARYPATH/mine.js:1:1)',
  '    at node:internal/modules/cjs/loader:1554:14'
].join('\n')), ['src/loops.js:412', 'slack-run.js:303'], 'only our files, relative, no paths');
assert.strictEqual(D.errorClass(new SyntaxError('CANARY')), 'SyntaxError');
assert.strictEqual(D.errorClass(new (class Weird extends Error {})()), 'Other');

/* ------------------------- nothing without consent ------------------------- */
writeCfg();
var day1 = run('2026-09-01');
var dm = [me(at(2026, 9, 1, 18), '```\n' + day1 + '\n```'), me(at(2026, 9, 1, 19), '1'),
          me(at(2026, 9, 1, 20), 'miss a')].join('\n');
run('2026-09-02', dm);
queueCrash(['x.json', '--config', cfgPath], new Error('CANARYMSG'));
assert.strictEqual(queued().length, 0, 'no consent: nothing is queued');
assert.ok(!fs.existsSync(outbox.files(dir).outbox), 'not even an empty outbox');

/* ------------------------- consent, then the canary run ------------------------- */
fs.rmSync(ledger);
writeCfg();
report.consent(cfgPath);
var cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
assert.ok(D.consent(cfg), 'consent writes a record');
day1 = run('2026-09-01');
dm = [me(at(2026, 9, 1, 18), '```\n' + day1 + '\n```'), me(at(2026, 9, 1, 19), '1'),
      me(at(2026, 9, 1, 20), 'miss a')].join('\n');
run('2026-09-02', dm);
var q = queued();
var wrong = q.filter(function (r) { return r.kind === 'item_wrong'; });
var missed = q.filter(function (r) { return r.kind === 'item_missed'; });
assert.strictEqual(wrong.length, 1, 'one rejection, one report: ' + JSON.stringify(q));
assert.strictEqual(keysOf(wrong[0]), ['age_days', 'listed', 'signal'].concat(COMMON.split(',')).sort().join(','));
assert.strictEqual(missed.length, 1, 'one answered spot check, one report');
assert.strictEqual(keysOf(missed[0]), ['missed', 'sampled'].concat(COMMON.split(',')).sort().join(','));
assert.strictEqual(missed[0].missed, 1);
assert.strictEqual(missed[0].sampled, 3);

run('2026-09-03', dm);
assert.strictEqual(queued().length, 2, 'the same replies read again queue nothing new');

queueCrash(['x.json', '--config', cfgPath], (function () {
  var e = new TypeError('CANARYMSG at ' + dir + ' for ' + ME);
  e.stack = 'TypeError: CANARYMSG\n    at a (' + path.join(dir, 'checkout', 'src', 'digest.js') + ':88:3)\n' +
    '    at b (' + path.join(dir, 'CANARYPATH.js') + ':1:1)';
  return e;
})());
var crash = queued().filter(function (r) { return r.kind === 'run_failed'; })[0];
assert.ok(crash, 'a crash is queued');
assert.deepStrictEqual([crash.stage, crash.error, crash.where], ['runner', 'TypeError', ['src/digest.js:88']]);
assert.strictEqual(keysOf(crash), ['error', 'stage', 'where'].concat(COMMON.split(',')).sort().join(','));

noCanary(fs.readFileSync(outbox.files(dir).outbox, 'utf8'), 'the outbox');

/* ------------------------------ sending ------------------------------ */
var bodies = [], statuses = [];
var server = http.createServer(function (req, res) {
  var b = '';
  req.on('data', function (c) { b += c; });
  req.on('end', function () {
    bodies.push({ url: req.url, body: b });
    res.statusCode = statuses.length ? statuses.shift() : 200;
    res.end('{}');
  });
});

(async function () {
  await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
  process.env.OPEN_LOOPS_REPORT_URL = 'http://127.0.0.1:' + server.address().port;

  var out = await report.main(['--send', '--failed', 'fetch_slack', '--config', cfgPath]);
  assert.ok(/4 sent, 0 queued/.test(out), out);
  bodies.forEach(function (b) {
    noCanary(b.body, 'a POST body');
    assert.strictEqual(b.url, '/report');
    assert.ok(D.exact(JSON.parse(b.body)), 'every body is exactly a report: ' + b.body);
  });
  var host = bodies.map(function (b) { return JSON.parse(b.body); }).filter(function (r) { return r.stage === 'fetch_slack'; })[0];
  assert.deepStrictEqual([host.error, host.where], ['Other', []], 'a host-stage failure has no code location');
  assert.ok(!fs.existsSync(outbox.files(dir).outbox), 'delivered reports leave the outbox');
  assert.strictEqual(fs.readFileSync(outbox.files(dir).log, 'utf8').split('\n').filter(function (l) { return / sent /.test(l); }).length, 4,
    'and each is logged');
  await assert.rejects(report.main(['--send', '--failed', 'CANARY', '--config', cfgPath]), /--failed takes one of/);

  // The outbox is a file anyone can edit. What is sent is rebuilt from the allowlist.
  queueCrash(['x.json', '--config', cfgPath], new URIError('CANARYMSG'));
  queueCrash(['x.json', '--config', cfgPath], new URIError('CANARYMSG'));
  assert.strictEqual(outbox.read(dir).length, 1, 'the same failure on the same day is queued once');
  var tampered = outbox.read(dir);
  tampered[0].report.note = 'CANARY';
  outbox.write(dir, tampered);
  bodies = [];
  await report.main(['--send', '--config', cfgPath]);
  assert.strictEqual(bodies.length, 1);
  noCanary(bodies[0].body, 'a tampered outbox entry');

  // A server that fails keeps the report; one that refuses it drops it.
  bodies = [];
  queueCrash(['x.json', '--config', cfgPath], new RangeError('CANARYMSG'));
  statuses = [503];
  assert.ok(/0 sent, 1 queued/.test(await report.main(['--send', '--config', cfgPath])), 'a 503 keeps it');
  assert.strictEqual(outbox.read(dir)[0].tries, 1);
  statuses = [400];
  assert.ok(/1 dropped/.test(await report.main(['--send', '--config', cfgPath])), 'a 400 drops it');
  assert.ok(!fs.existsSync(outbox.files(dir).outbox));
  queueCrash(['x.json', '--config', cfgPath], new RangeError('CANARYMSG'));
  var e0 = outbox.read(dir);
  e0[0].tries = outbox.MAX_TRIES;
  outbox.write(dir, e0);
  bodies = [];
  await report.main(['--send', '--config', cfgPath]);
  assert.strictEqual(bodies.length, 0, 'tried too often: discarded, not sent');

  // No server configured yet: nothing sent, nothing lost.
  process.env.OPEN_LOOPS_REPORT_URL = '';
  queueCrash(['x.json', '--config', cfgPath], new ReferenceError('CANARYMSG'));
  assert.ok(/no report server set yet/.test(await report.main(['--send', '--config', cfgPath])));
  assert.strictEqual(outbox.read(dir).length, 1, 'kept for when there is one');
  process.env.OPEN_LOOPS_REPORT_URL = 'http://127.0.0.1:' + server.address().port;

  /* ------------------------------ turning it off ------------------------------ */
  writeCfg({ diagnostics: false });
  bodies = [];
  assert.ok(/0 sent, 0 queued/.test(await report.main(['--send', '--config', cfgPath])));
  assert.strictEqual(bodies.length, 0, 'off: nothing is sent');
  assert.ok(!fs.existsSync(outbox.files(dir).outbox), 'and the queue is discarded');
  assert.ok(/discarded 1 unsent report — diagnostics off/.test(fs.readFileSync(outbox.files(dir).log, 'utf8')));
  queueCrash(['x.json', '--config', cfgPath], new Error('CANARYMSG'));
  assert.ok(!fs.existsSync(outbox.files(dir).outbox), 'and nothing new is queued');

  // Off and on again with no run in between: the old queue is still on disk, and must not go.
  writeCfg(); report.consent(cfgPath);
  queueCrash(['x.json', '--config', cfgPath], new Error('CANARYMSG'));
  var stale = outbox.read(dir);
  writeCfg({ diagnostics: false });
  writeCfg(); report.consent(cfgPath);          // renewed consent: a new install id
  assert.notStrictEqual(D.consent(JSON.parse(fs.readFileSync(cfgPath, 'utf8'))).install, stale[0].report.install);
  stale[0].queuedAt = new Date().toISOString();  // queued "after" the new consent, even
  outbox.write(dir, stale);                      // as if nothing ran while it was off
  bodies = [];
  await report.main(['--send', '--config', cfgPath]);
  assert.strictEqual(bodies.length, 0, 'reports queued under an earlier consent are never sent');
  assert.ok(!fs.existsSync(outbox.files(dir).outbox), 'they are discarded');

  // The same with the runner as the first thing to see the change.
  queueCrash(['x.json', '--config', cfgPath], new Error('CANARYMSG'));
  writeCfg({ diagnostics: false });
  fs.rmSync(ledger);
  run('2026-09-01');
  assert.ok(!fs.existsSync(outbox.files(dir).outbox), 'a run with diagnostics off discards the queue');

  /* ------------------------------ an example ------------------------------ */
  writeCfg(); report.consent(cfgPath);
  fs.rmSync(ledger);
  run('2026-09-01');
  var shown = await report.main(['--example', '1', '--config', cfgPath]);
  assert.ok(/This would be sent, exactly as written/.test(shown), shown);
  assert.ok(/CANARYTEXT/.test(shown), 'an example is the one thing that carries the sentence — shown first');
  var draft = JSON.parse(fs.readFileSync(path.join(dir, 'example-draft.json'), 'utf8'));
  assert.ok(D.exact(draft));
  assert.ok(!/@|UCANARY/.test(draft.text), 'emails and Slack ids become placeholders');
  draft.text = 'edited by the reader';
  fs.writeFileSync(path.join(dir, 'example-draft.json'), JSON.stringify(draft));
  bodies = [];
  assert.strictEqual(await report.main(['--send-example', '--config', cfgPath]), 'Sent.');
  assert.deepStrictEqual(JSON.parse(bodies[0].body), draft, 'what is sent is the draft as the reader left it');
  assert.strictEqual(bodies[0].url, '/example');
  assert.strictEqual(report.scrub('mail a.b@c.co or <@U0ABCDEFGH>, U0C1JCK7B6X, CONTRACTS'), 'mail person@example.com or @someone, SLACK_ID, CONTRACTS');

  server.close();
  console.log('diagnostics: OK');
})().catch(function (e) { console.error(e); process.exit(1); });
