/* The ledger's job is to make a repeated list readable: what is new, what has been
 * sitting there, what fell off, what was never real. All of that is pure enough to
 * test here — only the Sheet reads and writes need Apps Script. */
var assert = require('assert');

// ledger.js uses loopKey as a free variable, the way it does inside Apps Script.
global.loopKey = require('./src/loops.js').loopKey;
var L = require('./src/ledger.js');
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

/* --- marking wrong by replying --- */

/* The shapes a person actually types when told "reply with just its number". */
assert.deepStrictEqual(L.parseMarks('3 7', 15).wrong, [3, 7]);
assert.deepStrictEqual(L.parseMarks('3, 7', 15).wrong, [3, 7]);
assert.deepStrictEqual(L.parseMarks('3 and 7 arent real', 15).wrong, [3, 7]);
assert.deepStrictEqual(L.parseMarks('#3, #7 please', 15).wrong, [3, 7]);
assert.deepStrictEqual(L.parseMarks('7\n3\n', 15).wrong, [7, 3]);
assert.deepStrictEqual(L.parseMarks('3 3 7', 15).wrong, [3, 7], 'a repeated number is one mark');
assert.deepStrictEqual(L.parseMarks('', 15).wrong, [], 'an empty reply marks nothing');
assert.deepStrictEqual(L.parseMarks('all good thanks', 15).wrong, [], 'and so does a reply with no numbers');

/* Out of range is the important one — a quoted digest is full of dates and counts,
 * and 2026 must never be read as a mark. */
assert.deepStrictEqual(L.parseMarks('0 16 2026 99', 15).wrong, [], 'numbers outside the list are ignored');

/* Dates and times are the trap: "2026-08-25" offers up 8 and 25, and people quote
   dates when saying which item they mean. Only standalone numbers count. */
assert.deepStrictEqual(L.parseMarks('due 2026-08-25, item 4', 15).wrong, [4],
  'an ISO date in the reply does not become a mark');
assert.deepStrictEqual(L.parseMarks('the 08/25 one and 6', 15).wrong, [6], 'nor a slashed date');
assert.deepStrictEqual(L.parseMarks('the 9:15 call, plus 2', 15).wrong, [2], 'nor a time');
assert.deepStrictEqual(L.parseMarks('item 4.', 15).wrong, [4], 'a trailing full stop is still a mark');
assert.deepStrictEqual(L.parseMarks('3 is wrong. 7 too.', 15).wrong, [3, 7], 'sentences ending in numbers');
assert.deepStrictEqual(L.parseMarks('the 3.5 hour one, and 8', 15).wrong, [8], 'but a decimal is not two marks');

/* --- resolving those numbers against the list as it was sent --- */
var sent = ['k-alpha', 'k-beta', 'k-gamma'];
var led = [
  ['k-alpha', '2026-08-01', '2026-08-06', '', 'owed_by_us', 'a@b.com', 'alpha', ''],
  ['k-beta', '2026-08-01', '2026-08-06', '', 'owed_to_us', 'b@b.com', 'beta', ''],
  ['k-gamma', '2026-08-01', '2026-08-06', '', 'unanswered_ask', 'c@b.com', 'gamma', '']
];
assert.strictEqual(L.applyMarks(led, sent, { wrong: [1, 3] }), 2, 'two marks, two rows changed');
assert.strictEqual(led[0][COL.verdict], 'x');
assert.strictEqual(led[1][COL.verdict], '', 'the unmarked one is untouched');
assert.strictEqual(led[2][COL.verdict], 'x');
assert.strictEqual(L.applyMarks(led, sent, { wrong: [1] }), 0, 'marking the same item twice changes nothing');

/* The whole reason the digest's order is recorded: item 1 today is not item 1
   tomorrow, so a stale reply must resolve against the list it was answering. */
var reordered = ['k-gamma', 'k-alpha', 'k-beta'];
var fresh2 = [
  ['k-alpha', '', '', '', 'owed_by_us', '', 'alpha', ''],
  ['k-beta', '', '', '', 'owed_to_us', '', 'beta', '']
];
L.applyMarks(fresh2, reordered, { wrong: [2] });
assert.strictEqual(fresh2[0][COL.verdict], 'x', 'number 2 in that digest was alpha, not beta');
assert.strictEqual(fresh2[1][COL.verdict], '');

/* A number pointing at nothing must not throw or mark something arbitrary. */
assert.strictEqual(L.applyMarks(fresh2, ['k-missing'], { wrong: [1] }), 0, 'an unknown key marks nothing');

/* --- "real, but I already knew" --- */

/* A line led by k means known rather than wrong. Bare numbers stay a rejection, so
   the common case costs nothing extra. */
var both = L.parseMarks('3 7\nk 1 4', 15);
assert.deepStrictEqual(both.wrong, [3, 7], 'the bare line rejects');
assert.deepStrictEqual(both.knew, [1, 4], 'the k line marks as already known');
assert.deepStrictEqual(L.parseMarks('knew 2\nalready 5\n9', 15).knew, [2, 5],
  'knew and already read the same way');
assert.deepStrictEqual(L.parseMarks('knew 2\nalready 5\n9', 15).wrong, [9]);
assert.deepStrictEqual(L.parseMarks('k 1 4', 15).wrong, [], 'a k line rejects nothing');

/* A known item stays open — it is still outstanding, it just stops counting as
   something the digest told anyone. */
var kRows = [
  ['k-a', '', '', '', 'owed_by_us', '', 'a', ''],
  ['k-b', '', '', '', 'owed_by_us', '', 'b', '']
];
L.applyMarks(kRows, ['k-a', 'k-b'], { wrong: [2], knew: [1] });
assert.strictEqual(kRows[0][COL.verdict], 'k');
assert.strictEqual(kRows[1][COL.verdict], 'x');
assert.ok(L.isKnown('k') && L.isKnown('knew') && L.isKnown('already'));
assert.ok(!L.isKnown('x') && !L.isWrong('k'), 'the two verdicts never overlap');

var kept = L.mergeLedger(kRows, [loop({ threadId: 'k-thread' })], '2026-08-06');
assert.strictEqual(kept.suppressed, 0, 'nothing is suppressed by a known mark');

/* --- retention --- */

var old = function (key, lastSeen) {
  return [key, '2026-01-01', lastSeen, '', 'owed_by_us', 'a@b.com', 'text', ''];
};
var aging = [old('keep', '2026-08-01'), old('drop', '2026-05-01'), old('edge', '2026-05-09')];
assert.strictEqual(L.pruneLedger(aging, '2026-08-06', 90), 1, 'only the row past the window goes');
assert.deepStrictEqual(aging.map(function (r) { return r[0]; }), ['keep', 'edge'],
  'and pruning mutates in place, since that is what gets written back');
assert.strictEqual(L.pruneLedger(aging, '2026-08-06', 0), 0, 'zero means keep everything');

/* The trap: a row hidden as wrong is still being detected, so its clock has to keep
   running. If it went stale it would be pruned while live, and return as brand new. */
var hidden = [['h', '2026-08-01', '2026-08-01', '', 'owed_by_us', 'a@b.com', 'text', 'x']];
L.mergeLedger(hidden, [loop({ threadId: 'h-thread' })], '2026-11-01');
hidden[0][COL.key] = L.cell(hidden[0][COL.key]);
var stillDetected = [['h2', '2026-08-01', '2026-08-01', '', 'owed_by_us', '', 'text', 'x']];
var live = loop({ threadId: 't1' });
stillDetected[0][COL.key] = global.loopKey(live);
L.mergeLedger(stillDetected, [live], '2026-11-01');
assert.strictEqual(stillDetected[0][COL.last_seen], '2026-11-01',
  'a suppressed row is still touched by the run that detected it');
assert.strictEqual(L.pruneLedger(stillDetected, '2026-11-01', 90), 0,
  'so retention does not delete a live item out from under itself');

/* --- keeping the key but not the words --- */
var noText = [];
L.mergeLedger(noText, [loop()], '2026-08-06', { storeText: false });
assert.ok(noText[0][COL.key], 'the key is kept, so suppression still works');
assert.strictEqual(noText[0][COL.what], '', 'but the sentence is not stored');
assert.strictEqual(noText[0][COL.who], '', 'nor the counterparty');
var withText = [];
L.mergeLedger(withText, [loop()], '2026-08-06');
assert.ok(withText[0][COL.what], 'text is kept by default');

/* --- learning the kind, not just the instance --- */

/* A phrase is only worth proposing if it separates the misses from the real ones.
   "i'll send" is in both and says nothing; "at some point" is only in the rejects. */
var judged = [
  ['a', '', '', '', 'owed_by_us', '', "We'll revisit pricing at some point.", 'x'],
  ['b', '', '', '', 'owed_by_us', '', "I'll look at headcount at some point.", 'x'],
  ['c', '', '', '', 'owed_by_us', '', "I'll send the pricing sheet Thursday.", ''],
  ['d', '', '', '', 'owed_by_us', '', "I'll send the deck tomorrow.", '']
];
var s = L.suggestMutes(judged);
var got = s.map(function (x) { return x.phrase; });
assert.ok(got.indexOf('at some point') > -1, 'the phrase common to both rejects is proposed');
assert.ok(got.every(function (p) { return p.indexOf("i'll send") === -1; }),
  'a phrase that also appears in kept items is not evidence of anything');
assert.strictEqual(s.filter(function (x) { return x.phrase === 'at some point'; })[0].count, 2);

/* Overlapping n-grams would otherwise say the same thing three times. */
assert.ok(got.indexOf('at some') === -1 && got.indexOf('some point') === -1,
  'only the longest of a nested set survives');

/* One rejection is not a pattern. */
assert.deepStrictEqual(L.suggestMutes([judged[0], judged[2]]), [],
  'below the threshold it says nothing rather than guessing');

/* Muting drops matching items outright, before they can become ledger rows. */
var loops = [
  { what: "We'll revisit pricing at some point." },
  { what: "I'll send the pricing sheet Thursday." },
  { what: 'AT SOME POINT we should talk.' }
];
assert.strictEqual(L.applyMutes(loops, ['at some point']).length, 1, 'case does not matter');
assert.strictEqual(L.applyMutes(loops, [])[0].what, loops[0].what, 'no patterns changes nothing');
assert.strictEqual(L.applyMutes(loops, ['']).length, 3, 'an empty pattern must not mute everything');

/* --- both numbers --- */
var p = L.precision([
  ['k1', '', '', '', 'owed_by_us', '', '', ''],
  ['k2', '', '', '', 'owed_by_us', '', '', 'x'],
  ['k3', '', '', '', 'unanswered_ask', '', '', ''],
  ['k4', '', '', '', 'unanswered_ask', '', '', 'wrong'],
  ['k5', '', '', '', 'unanswered_ask', '', '', 'k']
]);
assert.strictEqual(p.total, 5);
assert.strictEqual(p.wrong, 2);
assert.strictEqual(p.knew, 1, 'known items are counted separately from wrong ones');
assert.strictEqual(p.news, 2, 'and what is left is what this actually told anyone');
assert.strictEqual(p.byType.owed_by_us.wrong, 1, 'the wrong-rate is broken out per signal');
assert.strictEqual(p.byType.unanswered_ask.total, 3);
assert.strictEqual(p.byType.unanswered_ask.knew, 1);

console.log('ledger: OK');
