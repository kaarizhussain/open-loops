/* The digest renderer, exercised with no Apps Script anywhere near it.
 *
 * That is the whole point of it having moved out of Code.gs: a second runtime has to
 * be able to produce the same digest without a spreadsheet, a mailbox or a clock.
 * If this file ever needs a Google stub to pass, the extraction has leaked. */
var assert = require('assert');
var loops = require('./src/loops.js');

// Same convention ledger.js uses — the renderer reads these as free variables.
global.OWNER = loops.OWNER;
global.LABEL = loops.LABEL;
global.loopKey = loops.loopKey;

var { render, headline, digestOrder } = require('./src/digest.js');
var F = require('./src/fixture.js');

var opts = { exec: F.EXEC, today: F.TODAY, contacts: F.RELATIONSHIPS };
var result = loops.detectLoops(F.MESSAGES, F.EVENTS, opts);
var briefs = loops.meetingBriefs(F.MESSAGES, F.EVENTS, result.open, opts);
var keys = digestOrder(result.open);

var text = render({
  today: F.TODAY, source: 'gmail',
  messages: F.MESSAGES, events: F.EVENTS, result: result, briefs: briefs,
  ledger: { fresh: 15, suppressed: 0, gone: [] },
  read: { threads: 18, capped: false, cap: '300-thread' },
  marked: 0
});

assert.ok(text.indexOf('OPEN LOOPS — for ' + F.TODAY) === 0, 'the date comes off the object, not a clock');
assert.ok(text.indexOf('Read 25 messages across 18 threads and 5 meetings.') > -1);
assert.ok(text.indexOf('CHASE THEM') > -1, 'the owner sections render');
assert.ok(!/undefined|NaN|\[object/.test(text), 'nothing leaked through as undefined');

/* --- numbering is what a reply quotes back, so it has to be exact --- */
assert.strictEqual(keys.length, result.open.length, 'every open item gets a number');
var numbered = text.split('\n').filter(function (l) { return /^\s*\d+\. \[/.test(l); });
assert.strictEqual(numbered.length, keys.length);
numbered.forEach(function (line, i) {
  assert.strictEqual(parseInt(line, 10), i + 1, 'numbering runs 1..n in print order: ' + line);
});

/* --- the headline, in each of its four states --- */
var mk = function (over) {
  var l = { subject: 'Meridian MSA', status: 'open', overdueDays: 0, ageDays: 3, rel: null };
  Object.keys(over || {}).forEach(function (k) { l[k] = over[k]; });
  return l;
};
assert.ok(/list is empty/.test(headline([])), 'nothing outstanding says so plainly');
assert.ok(/^One thing is overdue: Meridian MSA, 4 days past\.$/.test(
  headline([mk({ status: 'overdue', overdueDays: 4 })])), 'one overdue reads as a sentence');
assert.ok(/^3 are overdue\. The oldest by 9 days is Big Co \(Investor\)\.$/.test(headline([
  mk({ status: 'overdue', overdueDays: 2 }),
  mk({ status: 'overdue', overdueDays: 9, subject: 'Big Co', rel: { label: 'Investor' } }),
  mk({ status: 'overdue', overdueDays: 5 })
])), 'several overdue names the worst one and its tier');
assert.ok(/Nothing overdue\. 1 thing lands today/.test(
  headline([mk({ status: 'due_today' })])), 'no overdue falls back to what lands today');
assert.ok(/quietest is Meridian MSA, untouched for 11 days/.test(
  headline([mk({ ageDays: 11 })])), 'and with no deadlines at all, to what has gone quiet');

/* --- things a second runtime will not have --- */
var bare = render({
  today: '2026-08-06', messages: [], events: [],
  result: { open: [], closed: [] }, briefs: []
});
assert.ok(bare.indexOf('list is empty') > -1, 'renders with no ledger, no briefs, no read stats');
assert.ok(bare.indexOf('Ledger:') === -1, 'and links nothing when there is no ledger to link');

/* Truncation wording has to work for a source that does not count threads in Gmail's
   sense — the Slack runtime reads conversations, and the cap is its own. */
var capped = render({
  today: '2026-08-06', source: 'slack', messages: [], events: [],
  result: { open: [], closed: [] }, briefs: [],
  read: { threads: 40, capped: true, cap: '40-conversation' }
});
assert.ok(/across 40 conversations/.test(capped), 'a Slack read says conversations, not threads');
assert.ok(/INCOMPLETE — stopped at the 40-conversation limit/.test(capped),
  'and names its own limit rather than Gmail\'s');

console.log('digest: OK');
