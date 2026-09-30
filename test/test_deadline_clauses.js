/* Which date belongs to a commitment when the sentence mentions more than one.
 *
 * The bug: parseDue read the whole sentence and let "tomorrow" or "today" beat the weekday the promise was made for. "I'll send it
 * Thursday, I'm traveling tomorrow" was due tomorrow. The rule is narrow: the commitment's own clause, else a clause that is only a
 * deadline right next to it, else undated when a date sits in a clause that cannot be tied to the commitment. Every case is run in BOTH
 * directions, because the detector dates a promise made to you the same way as one you made.
 * Dates are fixed: 2026-09-22 is a Wednesday.
 */
var assert = require('assert');
var loops = require('../src/loops.js');

var ME = 'me@x.com';
var detect = function (body, dir, today) {
  var incoming = dir === 'in';
  return loops.detectLoops([{ id: 'm1', from: incoming ? 'a@y.com' : ME, to: [incoming ? ME : 'a@y.com'], subject: 's', date: today + 'T10:00', body: body, threadId: 't' }], [],
    { exec: ME, today: today, principals: [] }).open;
};
var TODAY = '2026-09-22';
/* "I'll" is the reader's own promise; "We'll" said by the other side is owed to the reader. Same sentence, same date. */
var dueBoth = function (mine, today) {
  var theirs = mine.replace(/\bI'll\b/g, "We'll").replace(/\bwill send\b/, 'will send');
  var a = detect(mine, 'out', today || TODAY), b = detect(theirs, 'in', today || TODAY);
  assert.strictEqual(a.length, 1, mine + ' -> ' + a.length + ' loops (outgoing)'); assert.strictEqual(b.length, 1, theirs + ' -> ' + b.length + ' loops (incoming)');
  assert.strictEqual(a[0].type, 'owed_by_us'); assert.strictEqual(b[0].type, 'owed_to_us');
  assert.strictEqual(a[0].due, b[0].due, 'both directions date it the same: ' + mine);
  return a[0].due;
};

/* ------------------------------ the commitment's own clause wins ------------------------------ */
assert.strictEqual(dueBoth("I'll send it Thursday, I'm traveling tomorrow."), '2026-09-24', 'Thursday, not tomorrow');
assert.strictEqual(dueBoth("I'm traveling tomorrow, will send it Thursday."), '2026-09-24', 'the incidental clause can come first');
assert.strictEqual(dueBoth("I'll send it Friday, but I'm out today."), '2026-09-25');
assert.strictEqual(dueBoth("I'll send it Thursday; Dana is in tomorrow."), '2026-09-24');
assert.strictEqual(dueBoth("I'll send it Thursday — I'm out tomorrow."), '2026-09-24');
// A comma inside a date is part of the date.
assert.strictEqual(dueBoth("I'll send it Friday, June 19, Dana is out tomorrow.", '2026-05-01'), '2026-06-19');
assert.strictEqual(dueBoth("I'll send it on June 19, 2026, Dana is out tomorrow.", '2026-05-01'), '2026-06-19', 'and so is the comma before a year');

/* ------------------------------ a clause that is only a deadline belongs to the commitment next to it ------------------------------ */
assert.strictEqual(dueBoth("By Thursday, I'll send it; Dana arrives tomorrow."), '2026-09-24', 'the original fallback bug: not tomorrow');
assert.strictEqual(dueBoth("I'll send it, by Thursday."), '2026-09-24');
assert.strictEqual(dueBoth("Deadline is Friday, I'll send it."), '2026-09-25');
assert.strictEqual(dueBoth("By the 15th, I'll send it; Dana is in tomorrow."), '2026-10-15');
assert.strictEqual(dueBoth("EOD tomorrow, I'll send it; Dana is out Friday."), '2026-09-23');
assert.strictEqual(dueBoth("Friday, June 19 — I'll send it.", '2026-05-01'), '2026-06-19', 'a dated clause with its own comma is still only a deadline');
assert.strictEqual(dueBoth("Thursday at 5pm, I'll send it; Dana is in tomorrow."), '2026-09-24');

/* ------------------------------ ambiguous associations stay undated ------------------------------ */
['Dana arrives tomorrow, I\'ll send it.',              // a date, but about Dana
 'Thursday works for Dana, I\'ll send it.',            // might be the deadline; cannot be told from Dana's availability
 'Tomorrow I\'ll be out but I\'ll send it Thursday.',  // two commitment clauses, two dates
 'I\'ll, uh, send it Friday.',                          // a bare cue split from its verb phrase by a parenthetical
 'Dana is in Friday, I\'ll send it; Sam is out tomorrow.'].forEach(function (t) {
  var a = detect(t, 'out', TODAY), b = detect(t.replace(/\bI'll\b/g, "We'll"), 'in', TODAY);
  assert.strictEqual(a.length, 1, t); assert.strictEqual(b.length, 1, t);
  assert.strictEqual(a[0].due, null, 'left undated rather than guessed (outgoing): ' + t + ' -> ' + a[0].due);
  assert.strictEqual(b[0].due, null, 'left undated rather than guessed (incoming): ' + t + ' -> ' + b[0].due);
});

/* ------------------------------ everything with one clause reads as before ------------------------------ */
assert.strictEqual(dueBoth("I'll send it Thursday."), '2026-09-24');
assert.strictEqual(dueBoth("I'll send it tomorrow."), '2026-09-23');
assert.strictEqual(dueBoth("I'll send the deck Thursday and the notes Friday."), '2026-09-24', 'two dates in ONE clause: the existing rule');
assert.strictEqual(dueBoth("I'll send it by Sept 30."), '2026-09-30');
assert.strictEqual(dueBoth("I'll send it next week."), '2026-10-02');
assert.strictEqual(detect("I'll send it.", 'out', TODAY)[0].due, null, 'no date anywhere: no date');
assert.strictEqual(detect("I'll send it, Dana.", 'out', TODAY)[0].due, null, 'a comma with no date in it');
assert.strictEqual(loops.parseDue("I'll send it Thursday, I'm traveling tomorrow.", TODAY), '2026-09-23', 'parseDue itself is unchanged: other callers read borrowed text with it');

console.log('deadline clauses: OK');
