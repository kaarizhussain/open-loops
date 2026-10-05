/* The spot check's accounting (adversarial review 2026-10-05, Codex findings 3 and 4, and the corrections pass's C1/C2/C3).
 *
 * Each digest samples a few messages the detector found nothing in, and asks which of them it should have found. Recall is estimated from how many
 * were checked and how many were misses. Three things inflated or lost the count:
 *   - the sample was counted again for every later answer under the same digest (run-local guard only), so recall rose with no new message reviewed;
 *   - a second answer's misses were dropped when the first already counted the sample ("miss b", then "miss c": c was lost);
 *   - any line starting "miss" counted the whole sample as reviewed and clean, including "miss z" and "miss the meeting tomorrow".
 * Now each digest's sample is counted once, in the ledger; later answers add only misses not already named; a line that names no entry of the
 * sample is not an answer and is reported. Everything runs on temporary ledgers with synthetic data.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var { main } = require('../slack-run.js');
var L = require('../src/ledger.js');
var { fileStore } = require('../src/store.js');

var d = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-miss-'));
var ME = 'alex@example.com', UID = 'U0EXAMPLE001', ROOT = '1790870400.000001';
var cfg = path.join(d, 'c.json');
var SAMPLE = ['sample-a', 'sample-b', 'sample-c'];
var counter = 0;
/* A fresh ledger holding one digest (ref abcd, dated 2026-10-01) whose spot check asked about three messages. */
var fresh = function () {
  var ledger = path.join(d, 'ledger' + (counter++) + '.json');
  fs.writeFileSync(ledger, JSON.stringify({ rows: [], digests: {}, refs: { abcd: { date: '2026-10-01', keys: [], asked: SAMPLE } }, refsSince: '2026-10-01', seen: [], learned: [],
    audit: { checked: 0, quiet: 30, found: 3, missed: [], asked: {} } }));
  fs.writeFileSync(cfg, JSON.stringify({ you: ME, selfUid: UID, tzOffset: 0, lookbackDays: 30, spotCheck: 0, ledger: ledger }));
  return ledger;
};
var replyN = 0;
/* One real run on `today`, with these replies typed under digest abcd (each a new message). Returns the digest text and the ledger as saved. */
var step = function (ledger, today, replies) {
  var dm = [{ ts: ROOT, user: UID, text: 'OPEN LOOPS — for 2026-10-01 · ref abcd' }].concat(replies.map(function (r) {
    return { ts: '1790871' + String(100 + (replyN++)) + '.000001', thread_ts: ROOT, user: UID, text: r };
  }));
  var input = path.join(d, 'in' + (counter++) + '.json');
  fs.writeFileSync(input, JSON.stringify({ today: today, conversations: [{ channel: '#ops', messages: [{ ts: '1790870800.000001', user: UID, text: "I'll send the signed contract Friday." }, { ts: '1790870900.000001', user: 'U0EXAMPLE002', text: 'Thanks.' }], complete: true }],
    dm: { messages: dm }, dmLookup: 'found' }));
  var out = main([input, '--config', cfg]);
  return { out: out, audit: JSON.parse(fs.readFileSync(ledger, 'utf8')).audit };
};
var recallLine = function (out) { var m = out.match(/Recall so far: about (\d+)% — (\d+) misses found in (\d+) messages spot-checked/); return m && { rate: +m[1], missed: +m[2], checked: +m[3] }; };
var ids = function (audit) { return audit.missed.map(function (m) { return m.id; }); };

/* ------------------------------ a sample is counted once per digest ------------------------------ */
var ledger = fresh();
var a = step(ledger, '2026-10-03', ['miss b']);
assert.deepStrictEqual([a.audit.checked, ids(a.audit)], [3, ['sample-b']], 'the first answer counts the sample of 3, and its one miss');
assert.deepStrictEqual(recallLine(a.out), { rate: recallLine(a.out).rate, missed: 1, checked: 3 }, 'the digest says 1 miss in 3');
var rate1 = recallLine(a.out).rate;
// Codex's repro: a later answer under the same digest, on another day, that names no new miss.
var b = step(ledger, '2026-10-04', ['miss']);
assert.deepStrictEqual([b.audit.checked, ids(b.audit)], [3, ['sample-b']], 'a later bare "miss" does not count the sample again, and keeps the recorded miss');
assert.deepStrictEqual(recallLine(b.out), { rate: rate1, missed: 1, checked: 3 }, 'recall is unchanged: nothing new was reviewed');
// A later answer naming a new letter adds only that miss; the sample is still counted once.
var c = step(ledger, '2026-10-05', ['miss b c']);
assert.deepStrictEqual([c.audit.checked, ids(c.audit)], [3, ['sample-b', 'sample-c']], 'a new letter is added, b is not recorded twice, and the sample is still counted once');
assert.deepStrictEqual(c.audit.answered.abcd, { sampled: 3, letters: ['b', 'c'] }, 'the ledger records what has been named');
var c2 = step(ledger, '2026-10-06', ['miss b c', 'miss c']);
assert.deepStrictEqual([c2.audit.checked, ids(c2.audit)], [3, ['sample-b', 'sample-c']], 'naming them all again changes nothing');

// Two answers in the same read: the second one's miss is not lost.
var same = step(fresh(), '2026-10-03', ['miss b', 'miss c']);
assert.deepStrictEqual([same.audit.checked, ids(same.audit)], [3, ['sample-b', 'sample-c']], 'two replies read together: both misses, one count');

// The reply a different, earlier way: bare miss first, then letters.
var bare = fresh();
var b1 = step(bare, '2026-10-03', ['miss']);
assert.deepStrictEqual([b1.audit.checked, ids(b1.audit)], [3, []], 'a bare miss counts the sample as reviewed and clean');
var b2 = step(bare, '2026-10-04', ['miss a']);
assert.deepStrictEqual([b2.audit.checked, ids(b2.audit)], [3, ['sample-a']], 'and a later miss names one without recounting');

/* ------------------------------ a line that names nothing in the sample is not an answer ------------------------------ */
var NOTREAD = function (line) { return 'NOT READ AS A CORRECTION — "' + line + '". Nothing on that line was applied. To report a message the spot check missed, reply "miss" with its letter, like "miss b".'; };
['miss z', 'miss the meeting tomorrow', 'm is the middle initial', 'miss e', 'miss b z', 'miss I think so'].forEach(function (line) {
  var r = step(fresh(), '2026-10-03', [line]);
  assert.deepStrictEqual([r.audit.checked, ids(r.audit)], [0, []], '"' + line + '": nothing is counted as reviewed');
  assert.strictEqual(recallLine(r.out), null, '"' + line + '": and no recall is claimed');
  assert.ok(r.out.indexOf(NOTREAD(line)) > -1, '"' + line + '": the reader is told, with the way to answer:\n' + r.out.split(String.fromCharCode(10)).slice(0, 8).join(String.fromCharCode(10)));
});
// An invalid line does not undo a valid answer, before or after it.
var mixed = step(fresh(), '2026-10-03', ['miss b', 'miss z']);
assert.deepStrictEqual([mixed.audit.checked, ids(mixed.audit)], [3, ['sample-b']], 'a valid answer stands beside an invalid one');
// The legitimate forms still answer: bare, none, letters with prose after them.
['miss', 'miss: none', 'miss none, a clean sample', 'm c', 'miss a b because both had dates'].forEach(function (line) {
  var r = step(fresh(), '2026-10-03', [line]);
  assert.strictEqual(r.audit.checked, 3, '"' + line + '" is an answer');
});

/* ------------------------------ the counts themselves are validated ------------------------------ */
// Misses cannot outnumber the messages checked, whatever is recorded.
var dup = fileStore(fresh());
dup.recordMisses([{ id: 'sample-a', on: '2026-10-01' }, { id: 'sample-a', on: '2026-10-01' }, { id: 'sample-b', on: '2026-10-01' }], 3, { abcd: { sampled: 3, letters: ['a', 'b'] } });
dup.recordMisses([{ id: 'sample-a', on: '2026-10-01' }], 0);
assert.deepStrictEqual([dup.audit().checked, ids(dup.audit())], [3, ['sample-a', 'sample-b']], 'the same miss is never recorded twice');
dup.recordMisses([], -5);
assert.strictEqual(dup.audit().checked, 3, 'and a negative count cannot lower what was checked');
// The figure shown is guarded too, for a ledger already holding more misses than checks.
assert.strictEqual(L.recall(10, 5, 3, 9).missed, 3, 'recall never shows more misses than messages checked');
assert.ok(L.recall(10, 5, 3, 9).estimatedMisses <= 5, 'or more estimated misses than there are quiet messages');

// A damaged record of answers is a damaged ledger.
var bad = fresh();
var raw = JSON.parse(fs.readFileSync(bad, 'utf8')); raw.audit.answered = { abcd: { sampled: 2, letters: ['a', 'b', 'c'] } };
fs.writeFileSync(bad, JSON.stringify(raw));
assert.throws(function () { fileStore(bad); }, /audit\.answered/, 'more letters named than the sample held is damage');

fs.rmSync(d, { recursive: true, force: true });
console.log('miss accounting: OK');
