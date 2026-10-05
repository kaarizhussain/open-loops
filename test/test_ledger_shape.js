/* A ledger, or its same-day snapshot, that parses but has a part of the wrong type is a damaged ledger (exit 4), found by
 * --check-ledger before any run. It used to pass the check and then crash the real run with exit 1 (codex-debug review of
 * 2026-10-05 finding 6, plus the shapes the adversarial ledger pass found: digests/refs/learned entries of the wrong type).
 * Every case is synthetic and runs in a temporary directory.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');

var ROOT = path.join(__dirname, '..');
var d = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-shape-'));
var row = ['owed_by_us|#ops|2026-10-01|synthetic', '2026-10-01', '2026-10-01', '', 'owed_by_us', '', 'I will send the synthetic contract.', 'x'];
var cfg = path.join(d, 'config.json');
var input = path.join(d, 'input.json');
fs.writeFileSync(input, JSON.stringify({ today: '2026-10-05', conversations: [{ channel: '#ops', messages: [], complete: true }], dm: { messages: [] }, dmLookup: 'searched_none' }));
var node = function (args) { return cp.spawnSync(process.execPath, [path.join(ROOT, 'slack-run.js')].concat(args), { encoding: 'utf8' }); };
var n = 0;
/* A real ledger with a real same-day snapshot: one real run on a fresh ledger holding a rejected row, which is what a second run on that day starts from. */
var base = function () {
  var ledger = path.join(d, 'base' + (n++) + '.json');
  fs.writeFileSync(ledger, JSON.stringify({ rows: [row], digests: {}, refs: {} }));
  fs.writeFileSync(cfg, JSON.stringify({ you: 'alex@example.com', ledger: ledger, useCalendar: false, spotCheck: 0, channels: { include: ['#ops'] } }));
  assert.strictEqual(node([input, '--config', cfg]).status, 0, 'the first run works');
  var l = JSON.parse(fs.readFileSync(ledger, 'utf8'));
  assert.ok(l.before && l.before.date === '2026-10-05' && l.before.state, 'it left a same-day snapshot');
  return l;
};
/* Returns { check, run } exit codes for a ledger with this content, and the ledger file's bytes before and after the run. */
var probe = function (ledgerObj) {
  var ledger = path.join(d, 'ledger' + (n++) + '.json');
  fs.writeFileSync(ledger, JSON.stringify(ledgerObj));
  fs.writeFileSync(cfg, JSON.stringify({ you: 'alex@example.com', ledger: ledger, useCalendar: false, spotCheck: 0, channels: { include: ['#ops'] } }));
  var before = fs.readFileSync(ledger, 'utf8');
  var check = node(['--check-ledger', ledger]), run = node([input, '--config', cfg]);
  return { check: check.status, run: run.status, stderr: run.stderr, same: fs.readFileSync(ledger, 'utf8') === before };
};

// A sound ledger, with and without a snapshot, is accepted and the run works.
var ok = probe(base());
assert.deepStrictEqual([ok.check, ok.run], [0, 0], 'a sound ledger with its same-day snapshot passes and the re-run works: ' + ok.stderr);

// Each damaged shape is exit 4 at the check AND at the run, and the file is left alone.
var DAMAGED = {
  'snapshot rows is a string (the review finding)': function (l) { l.before.state.rows = 'corrupted'; },
  'snapshot is an array': function (l) { l.before.state = []; },
  'snapshot rows hold strings': function (l) { l.before.state.rows = ['x']; },
  'snapshot digests is null': function (l) { l.before.state.digests = null; },
  'snapshot refs is a string': function (l) { l.before.state.refs = 'x'; },
  'snapshot has no date': function (l) { l.before.date = 20261005; },
  'a digest entry is a string': function (l) { l.digests = { '2026-10-01': 'str' }; },
  'a digest entry is null': function (l) { l.digests = { '2026-10-01': null }; },
  'a ref entry is null': function (l) { l.refs = { abcd: null }; },
  'a ref entry has no keys list': function (l) { l.refs = { abcd: { date: '2026-10-01' } }; },
  'seen is not a list': function (l) { l.seen = 'x'; },
  'learned holds null': function (l) { l.learned = [null]; }
};
Object.keys(DAMAGED).forEach(function (name) {
  var l = base(); DAMAGED[name](l);
  var r = probe(l);
  assert.strictEqual(r.check, 4, name + ': --check-ledger says damaged');
  assert.strictEqual(r.run, 4, name + ': the run says damaged, not a crash (' + r.stderr.split('\n')[0] + ')');
  assert.ok(r.same, name + ': the file is untouched');
});

fs.rmSync(d, { recursive: true, force: true });
console.log('ledger shape: OK');
