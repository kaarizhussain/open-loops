/* The ledger's job is to make a repeated list readable: what is new, what has been
 * sitting there, what fell off, what was never real. All of that is pure enough to
 * test here — only the Sheet reads and writes need Apps Script. */
var assert = require('assert');

// ledger.js uses loopKey as a free variable, the way it does inside Apps Script.
global.loopKey = require('../src/loops.js').loopKey;
var L = require('./ledger.js');
var COL = L.COL;

var loop = function (over) {
  var l = { type: 'owed_by_us', threadId: 't1', said: '2026-08-03',
            what: "I'll send the revenue section Thursday EOD", who: 'cfo@northstar.io' };
  Object.keys(over || {}).forEach(function (k) { l[k] = over[k]; });
  return l;
};

/* --- first sight --- */
var rows = [];
var r1 = L.mergeLedger(rows, [loop()], '2026-08-06');
assert.strictEqual(r1.fresh, 1, 'an unseen item is new');
assert.strictEqual(r1.shown.length, 1);
assert.strictEqual(r1.shown[0].isNew, true);
assert.strictEqual(r1.shown[0].trackedDays, 0);
assert.strictEqual(rows.length, 1, 'and it lands in the ledger');
assert.strictEqual(rows[0][COL.first_seen], '2026-08-06');

/* --- seen again three days later --- */
var r2 = L.mergeLedger(rows, [loop()], '2026-08-09');
assert.strictEqual(r2.fresh, 0, 'the same item is not new twice');
assert.strictEqual(r2.shown[0].isNew, false);
assert.strictEqual(r2.shown[0].trackedDays, 3, 'and the digest can say how long it has sat');
assert.strictEqual(rows.length, 1, 'no duplicate row');
assert.strictEqual(rows[0][COL.last_seen], '2026-08-09');

/* --- it stops being detected: dealt with --- */
var r3 = L.mergeLedger(rows, [], '2026-08-10');
assert.strictEqual(r3.gone.length, 1, 'an item the detector no longer finds has cleared');
assert.strictEqual(rows[0][COL.gone_on], '2026-08-10');

var r4 = L.mergeLedger(rows, [], '2026-08-11');
assert.strictEqual(r4.gone.length, 0, 'and it is only reported the once');

/* --- it comes back: it never really left --- */
var r5 = L.mergeLedger(rows, [loop()], '2026-08-12');
assert.strictEqual(rows[0][COL.gone_on], '', 'a returning item is not still cleared');
assert.strictEqual(r5.fresh, 0, 'and it is not new again either');
assert.strictEqual(r5.shown[0].trackedDays, 6, 'age still runs from when it first appeared');

/* --- marked wrong: gone for good --- */
rows[0][COL.verdict] = 'x';
var r6 = L.mergeLedger(rows, [loop()], '2026-08-13');
assert.strictEqual(r6.shown.length, 0, 'a false positive never reaches the digest again');
assert.strictEqual(r6.suppressed, 1);
assert.strictEqual(r6.gone.length, 0, 'and it is not celebrated as cleared either');

/* The verdicts a human actually types, versus the ones that mean nothing yet. */
['x', 'X', 'n', 'no', 'NOPE', 'wrong', 'false', 'fp'].forEach(function (v) {
  assert.ok(L.isWrong(v), 'should read as wrong: ' + v);
});
['', ' ', 'ok', 'yes', 'y', 'real', null, undefined].forEach(function (v) {
  assert.ok(!L.isWrong(v), 'should not read as wrong: ' + JSON.stringify(v));
});

/* --- two items in one thread stay distinct --- */
var rows2 = [];
L.mergeLedger(rows2, [loop(), loop({ what: "I'll book the venue by Friday" })], '2026-08-06');
assert.strictEqual(rows2.length, 2, 'different sentences in one thread are different loops');

/* --- Sheets hands dates back as Date objects --- */
assert.strictEqual(L.cell(new Date(2026, 7, 6)), '2026-08-06',
  'a Date from the sheet normalises back to the day it was written');
assert.strictEqual(L.cell('  2026-08-06 '), '2026-08-06');
assert.strictEqual(L.cell(null), '');

var dated = [['k1', new Date(2026, 7, 1), new Date(2026, 7, 5), '', 'owed_by_us', 'a@b.com', 'x', '']];
var r7 = L.mergeLedger(dated, [], '2026-08-06');
assert.strictEqual(r7.gone.length, 1, 'date-typed cells still compare correctly');

/* --- precision --- */
var p = L.precision([
  ['k1', '', '', '', 'owed_by_us', '', '', ''],
  ['k2', '', '', '', 'owed_by_us', '', '', 'x'],
  ['k3', '', '', '', 'unanswered_ask', '', '', ''],
  ['k4', '', '', '', 'unanswered_ask', '', '', 'wrong']
]);
assert.strictEqual(p.total, 4);
assert.strictEqual(p.wrong, 2);
assert.strictEqual(p.byType.owed_by_us.wrong, 1, 'the wrong-rate is broken out per signal');
assert.strictEqual(p.byType.unanswered_ask.total, 2);

console.log('ledger: OK');
