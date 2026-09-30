/* A hedge about something else must not hide a firm promise.
 *
 * The bug: any hedge word in front of a promise blocked it, wherever it came from. "I don't think you need to chase, I'll send it Friday"
 * is a firm promise with a remark about the listener attached, and it was dropped. The fix is two narrow shapes (about what the addressee
 * needs, about how urgent it is), set aside before the hedge test; uncertainty about the promise itself stays a hedge. Every case is
 * run in both directions: a promise made to you is hedged or firm by the same rule.
 */
var assert = require('assert');
var loops = require('../src/loops.js');

var ME = 'me@x.com', TODAY = '2026-09-22';
var detect = function (body, dir) {
  var incoming = dir === 'in';
  return loops.detectLoops([{ id: 'm1', from: incoming ? 'a@y.com' : ME, to: [incoming ? ME : 'a@y.com'], subject: 's', date: TODAY + 'T10:00', body: body, threadId: 't' }], [],
    { exec: ME, today: TODAY, principals: [] }).open;
};
/* "I'll" from the reader; "We'll" from the other side. */
var both = function (mine, expectLoop) {
  var theirs = mine.replace(/\bI'll\b/g, "We'll");
  [['out', mine], ['in', theirs]].forEach(function (c) {
    var r = detect(c[1], c[0]);
    assert.strictEqual(r.length, expectLoop ? 1 : 0, (expectLoop ? 'firm: ' : 'hedged: ') + c[1] + ' (' + c[0] + ') -> ' + r.length);
    if (expectLoop) assert.strictEqual(r[0].due, '2026-09-25', c[1] + ' keeps its Friday');
  });
};

/* ------------------------------ a hedge about the listener, or about urgency, is not a hedge on the promise ------------------------------ */
both("I don't think you need to chase, I'll send it Friday.", true);
both("I do not think you should wait, I'll send it Friday.", true);
both("I'm not sure you have to wait, I'll send it Friday.", true);
both("I doubt you really need it early, I'll send it Friday.", true);
both("I doubt that's urgent, but I'll send it Friday.", true);
both("I don't think it's a big deal, but I'll send it Friday.", true);
both("Not sure it's important, but I'll send it Friday.", true);
both("I don't think this is a problem; I'll send it Friday.", true);
both("I'll send it Friday, I don't think you need to chase.", true);

/* ------------------------------ uncertainty about the promise itself stays a hedge ------------------------------ */
[
  "No promises on timing, I'll send it Friday.",
  "No promises, I'll send it Friday.",
  'Not sure, I\'ll send it Friday.',
  'Not sure about the deck, I\'ll send it Friday.',           // ambiguous: unsure about the deck, or unsure it will go? left hedged
  "I'm not sure the pricing is final, I'll send the deck Friday.",
  'Maybe I\'ll send it Friday.',
  'Hopefully, I\'ll send it Friday.',
  'Perhaps I\'ll send it Friday.',
  "I don't think I'll be able to send it Friday.",
  "I'm not sure I can send it Friday, I'll try.",
  "I doubt I'll send it Friday.",
  "I don't think you'll like it, I'll send it Friday.",       // not one of the two shapes: unresolved, stays hedged
  "Probably not, but I'll send it Friday.",
  "Unlikely, but I'll send it Friday."
].forEach(function (t) { both(t, false); });

/* ------------------------------ another hedge in front of the promise still counts ------------------------------ */
both("I don't think you need to chase, maybe I'll send it Friday.", false);
both("I doubt that's urgent, but I doubt I'll send it Friday.", false);
both("I doubt that's urgent, but maybe I'll send it Friday.", false);
both("I don't think you need to chase, no promises, I'll send it Friday.", false);

/* ------------------------------ what was already true still is ------------------------------ */
both("I'll send it Friday, not sure about the deck though.", true);            // a hedge after the promise
both("Without a doubt I'll send it Friday.", true);
both("No doubt I'll send it Friday.", true);
both("I'll send it Friday.", true);
assert.deepStrictEqual(detect('I will not be able to send the deck Friday.', 'out'), [], 'a refusal is still a refusal');
assert.deepStrictEqual(detect("I can't promise I'll send it Friday.", 'in'), []);

console.log('hedge scope: OK');
