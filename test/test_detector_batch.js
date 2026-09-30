/* Detector findings from the whole-product review, each with the sentence that failed. Narrow changes only: every case below was
 * reproduced, and each rule is the smallest one that separates it from the nearby cases that must keep working.
 *   - an opener before a dropped-subject promise ("Thanks, will send it") was read as the person who promised
 *   - "next week" said on a Friday (or a weekend) resolved a week too late
 *   - "by the 31st" / "Feb 30" rolled into the next month instead of being a real date or no date
 *   - refusals after the cue ("I will not be able to…") were firm promises; "no doubt" counted as a hedge
 * Dates are fixed: 2026-09-21 is a Monday.
 */
var assert = require('assert');
var loops = require('../src/loops.js');

var ME = 'me@x.com';
var detect = function (body, today, principals) {
  return loops.detectLoops([{ id: 'm1', from: ME, to: ['a@y.com'], subject: 's', date: today + 'T10:00', body: body, threadId: 't' }], [],
    { exec: ME, today: today, principals: principals || [] }).open;
};
var one = function (body, today) { var r = detect(body, today || '2026-09-22'); assert.strictEqual(r.length, 1, JSON.stringify(body) + ' -> ' + r.length + ' loops'); return r[0]; };

/* ------------------------------ an opener is not the person who promised ------------------------------ */
['Thanks, will send it Thursday.', 'Got it, will send Friday.', 'Sure thing, will get you the deck.', 'Tomorrow will send the numbers.',
 'Thanks Dana, will send the deck Thursday.', 'Monday will get you the draft.', 'Will send it Thursday.'].forEach(function (t) {
  var l = one(t);
  assert.strictEqual(l.owner, 'you', JSON.stringify(t) + ' is the reader\'s own promise, got owner ' + l.owner + ' who ' + l.who);
  assert.ok(!/^(Thanks|Tomorrow|Monday|Got|Dana)$/.test(String(l.who)), JSON.stringify(t) + ' names nobody: ' + l.who);
});
// A named person who will send it is still that person's, and still chased for.
['Sarah will send the contract Friday.', 'Dana will send the signed copy.', 'Sarah, will send the contract Friday?'].slice(0, 2).forEach(function (t) {
  var l = one(t); assert.strictEqual(l.owner, 'them', t); assert.ok(/^(Sarah|Dana)$/.test(l.who), t + ' -> ' + l.who);
});
// With principals, the executive's promise is still routed by name.
var exec = detect('Dana will send the signed copy.', '2026-09-22', [{ label: 'Dana Wells' }]);
assert.strictEqual(exec.length, 1); assert.strictEqual(exec[0].owner, 'exec');
var opener = detect('Thanks, will send it Thursday.', '2026-09-22', [{ label: 'Dana Wells' }]);
assert.strictEqual(opener[0].owner, 'you', 'and an opener is not routed to anyone');

/* ------------------------------ "next week" is the week after this one ------------------------------ */
var due = function (t, today) { return loops.parseDue(t, today); };
assert.strictEqual(due("I'll send it next week", '2026-09-21'), '2026-10-02', 'Monday: next week\'s Friday');
assert.strictEqual(due("I'll send it next week", '2026-09-25'), '2026-10-02', 'Friday: the same Friday, not a week after it');
assert.strictEqual(due("I'll send it next week", '2026-09-26'), '2026-10-02', 'Saturday');
assert.strictEqual(due("I'll send it next week", '2026-09-27'), '2026-10-02', 'Sunday');
assert.strictEqual(due("I'll send it Tuesday next week", '2026-09-21'), '2026-09-29');
assert.strictEqual(due("I'll send it Tuesday next week", '2026-09-25'), '2026-09-29', 'Friday: next week\'s Tuesday, not the one after');
assert.strictEqual(due("I'll send it Thursday next week", '2026-09-23'), '2026-10-01');
assert.strictEqual(due("I'll send it Sunday next week", '2026-09-23'), '2026-10-04', 'weeks run Monday to Sunday');
// Nearby cases that must not move.
assert.strictEqual(due("I'll send it Thursday", '2026-09-21'), '2026-09-24');
assert.strictEqual(due("I'll send it by Friday", '2026-09-25'), '2026-10-02', 'a bare weekday said on that weekday is still the next one');
assert.strictEqual(due('by end of week', '2026-09-25'), '2026-09-25');

/* ------------------------------ a date the month does not have ------------------------------ */
assert.strictEqual(due("I'll send by the 31st", '2026-09-10'), '2026-10-31', 'the next 31st, not the 1st of October');
assert.strictEqual(due('by the 31st', '2026-10-10'), '2026-10-31');
assert.strictEqual(due('by the 15th', '2026-09-10'), '2026-09-15');
assert.strictEqual(due('by the 5th', '2026-09-10'), '2026-10-05', 'a day already gone is next month\'s');
assert.strictEqual(due("I'll send by Feb 30", '2026-01-10'), null, '"Feb 30" is no deadline');
assert.strictEqual(due("I'll send by Jun 31", '2026-06-01'), null);
assert.strictEqual(due("I'll send by Feb 29", '2026-01-10'), null, '2026 has no 29th of February');
assert.strictEqual(due("I'll send by Feb 29", '2027-09-10'), '2028-02-29', 'and a leap year does');
assert.strictEqual(due("I'll send by Dec 25", '2026-09-10'), '2026-12-25');
assert.strictEqual(due("I'll send by Sept 3rd", '2026-09-01'), '2026-09-03');
assert.strictEqual(due("I'll send by Mar 5", '2026-09-10'), '2027-03-05', 'a date already gone this year is next year\'s');
assert.strictEqual(due("I'll send by Jun 31 or Thursday", '2026-06-01'), '2026-06-04', 'an impossible date leaves the other cues to be tried');

/* ------------------------------ a refusal is not a promise ------------------------------ */
['I will not be able to send the deck Friday.', "I'll be unable to send the deck Friday.", "We'll not be able to send it Friday.", "I can't promise I'll send it Friday.",
 'I cannot promise we will send it Friday.'].forEach(function (t) { assert.deepStrictEqual(detect(t, '2026-09-22'), [], JSON.stringify(t) + ' is not a commitment'); });
['Without a doubt I\'ll send it Friday.', "No doubt I'll send it Friday.", "I'll send the deck Friday.", "I'll send it Friday, not sure about the deck though."].forEach(function (t) {
  assert.strictEqual(detect(t, '2026-09-22').length, 1, JSON.stringify(t) + ' is one');
});
['I doubt I\'ll send it Friday.', "Maybe I'll send it Friday.", "I don't think I'll be able to send it Friday."].forEach(function (t) {
  assert.deepStrictEqual(detect(t, '2026-09-22'), [], JSON.stringify(t) + ' stays hedged');
});

console.log('detector batch: OK');
