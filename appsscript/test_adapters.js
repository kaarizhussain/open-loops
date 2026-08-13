var assert = require('assert');
var { cleanBody, addr, addrList } = require('./adapters.js');
var { detectLoops } = require('../src/loops.js');

/* --- address parsing --- */
assert.strictEqual(addr('Paul Oyelaran <Paul@Meridian.com>'), 'paul@meridian.com');
assert.strictEqual(addr('dana@northstar.io'), 'dana@northstar.io');
assert.deepStrictEqual(addrList('A <a@x.com>, B <b@y.com>'), ['a@x.com', 'b@y.com']);
assert.deepStrictEqual(addrList(''), []);

/* --- quoted replies: the whole reason this file exists --- */
var gmailReply = [
  "Thanks Paul. I'll get you the revised pricing by Wednesday.",
  '',
  'On Mon, Aug 3, 2026 at 9:05 AM Paul Oyelaran <paul@meridian.com> wrote:',
  '',
  '> Hi Dana — checking in on the redlines.',
  "> I'll have our counsel look by Friday.",
  '>'
].join('\n');

var cleaned = cleanBody(gmailReply);
assert.strictEqual(cleaned, "Thanks Paul. I'll get you the revised pricing by Wednesday.");
assert.ok(cleaned.indexOf('counsel') === -1, 'the quoted promise must not survive');

/* the failure this prevents: without stripping, one thread yields the same promise twice */
var exec = 'dana@northstar.io';
var raw = [
  { id: 'm1', threadId: 't1', subject: 'Pricing', from: exec, to: ['paul@meridian.com'],
    date: '2026-08-03T09:00', attach: false,
    body: "I'll get you the revised pricing by Wednesday." },
  { id: 'm2', threadId: 't1', subject: 'Pricing', from: exec, to: ['paul@meridian.com'],
    date: '2026-08-04T09:00', attach: false,
    body: "Quick bump on the below.\n\nOn Mon, Aug 3, 2026 at 9:00 AM Dana <dana@northstar.io> wrote:\n\n> I'll get you the revised pricing by Wednesday." }
];
var withQuotes = detectLoops(raw, [], { exec: exec, today: '2026-08-06' });
var stripped = detectLoops(raw.map(function (m) {
  return Object.assign({}, m, { body: cleanBody(m.body) });
}), [], { exec: exec, today: '2026-08-06' });

assert.strictEqual(withQuotes.open.filter(function (l) { return l.type === 'owed_by_us'; }).length, 2,
  'unstripped, the same promise is found twice — this is the bug');
assert.strictEqual(stripped.open.filter(function (l) { return l.type === 'owed_by_us'; }).length, 1,
  'stripped, it is one commitment');

/* --- Outlook conventions --- */
assert.strictEqual(
  cleanBody("Will do.\n\n-----Original Message-----\nFrom: someone\n\n> old text"),
  'Will do.');
assert.strictEqual(
  cleanBody('Sounds good.\n\n_____________________\nFrom: Someone <s@x.com>\nSent: Monday'),
  'Sounds good.');
assert.strictEqual(
  cleanBody("On it.\n\nFrom: Someone <s@x.com>\nSent: Monday\nTo: Dana"),
  'On it.');

/* --- signatures --- */
assert.strictEqual(cleanBody("I'll send it Friday.\n\n--\nDana Whitfield\nCRO"), "I'll send it Friday.");
assert.strictEqual(cleanBody('Yes.\n\nSent from my iPhone'), 'Yes.');

/* --- must not over-strip --- */
assert.strictEqual(cleanBody('No quoting here at all.'), 'No quoting here at all.');
assert.ok(cleanBody("I'll review the From: field mapping tomorrow.").indexOf('review') > -1,
  'a line merely containing "From:" mid-sentence is not a header');
assert.strictEqual(cleanBody(''), '');
assert.strictEqual(cleanBody(null), '');

console.log('adapters: OK');
