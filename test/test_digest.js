/* The digest renderer, exercised with no Apps Script anywhere near it.
 *
 * That is the whole point of it having moved out of Code.gs: a second runtime has to
 * be able to produce the same digest without a spreadsheet, a mailbox or a clock.
 * If this file ever needs a Google stub to pass, the extraction has leaked. */
var assert = require('assert');
var loops = require('../src/loops.js');

// Same convention ledger.js uses — the renderer reads these as free variables.
global.OWNER = loops.OWNER;
global.LABEL = loops.LABEL;
global.loopKey = loops.loopKey;

var { render, headline, digestOrder, actionList, draft, firstName } = require('../src/digest.js');
var F = require('../src/fixture.js');

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

/* Measured below the short list, which cites the same numbers out of order on purpose
   and would otherwise be counted as part of the sequence. */
var body = text.split('…and ').slice(1).join('…and ') || text;
var numbered = body.split('\n').filter(function (l) { return /^\s*\d+\. \[/.test(l); });
assert.strictEqual(numbered.length, keys.length, 'one numbered line per open item');
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

/* --- the short list answers a different question from the long one --- */

/* The piles answer "what is outstanding, and who acts next". At nine in the morning
   the question is "what do I do next", and no amount of sorting forty items answers
   that — this is selection, not ordering. */
var block = text.split('DO THESE FIRST')[1].split('\n\n')[0].split('\n');
var head = block.filter(function (l) { return /^\s*\d+\. \[/.test(l); });
assert.strictEqual(head.length, 5, 'five moves by default, got: ' + head.join(' | '));

/* Numbered from the full list rather than renumbered, so replying "4" to reject
   something means the same thing wherever in the digest you read it. */
var refs = head.map(function (l) { return parseInt(l, 10); });
assert.ok(refs.every(function (n) { return n >= 1 && n <= result.open.length; }),
  'every reference points at a real item: ' + refs.join(','));
assert.ok(refs.some(function (n, i) { return i && n < refs[i - 1]; }),
  'and they are not in numeric order, because they are ranked by urgency not position');

/* One per counterparty. Chasing three people about five things is three messages, and
   five lines from one conversation is a single move dressed up as five. */
var parties = actionList(result.open, 5).map(function (l) { return l.who; });
assert.strictEqual(new Set(parties).size, parties.length, 'no counterparty appears twice');

/* The verb comes from the signal type, where it can honestly come from. A list of
   quotations still leaves you working out what to do with each one. */
assert.ok(/Send an agenda —/.test(text), 'a meeting with no agenda names the action');
assert.ok(/Chase /.test(text), 'something someone else owes is a chase');
assert.ok(block.every(function (l) { return l.length <= 82; }),
  'nothing wraps, drafts included — a list that wraps is not one you can scan: ' +
  block.filter(function (l) { return l.length > 82; }).join(' | '));

/* Below the threshold the full list already is the short list, and printing both is
   saying everything twice. */
var few = { today: F.TODAY, messages: [], events: [], briefs: [],
  result: { open: result.open.slice(0, 4), closed: [] } };
assert.strictEqual(render(few).indexOf('DO THESE FIRST'), -1, 'no short list for a short list');
assert.strictEqual(render({ today: F.TODAY, messages: [], events: [], briefs: [],
  actionList: 0, result: result }).indexOf('DO THESE FIRST'), -1, 'and it can be turned off');

/* --- the note to send, where sending a note is the move ---
 *
 * Without this an item only leaves the list when a message happens to appear, so
 * anything handled by phone nags forever. Paste it, send it, and the next run sees
 * your message and closes the loop — which is why this beats a "done" button: it
 * feeds closure detection instead of bypassing it. */
var d = function (over) {
  var l = { type: 'owed_to_us', status: 'overdue', who: 'paul.oyelaran@meridianhealth.com' };
  Object.keys(over || {}).forEach(function (k) { l[k] = over[k]; });
  return draft(l);
};

assert.ok(/^Hi Paul — /.test(d()), 'it opens with a name pulled off the address');
assert.ok(/holding it up/.test(d()), 'a late inbound promise is a chase');
assert.ok(/still on track/.test(d({ status: 'open' })), 'one that is not late is a check-in');
assert.ok(/bumping this one/.test(d({ type: 'awaiting_reply' })));
assert.ok(/slow reply/.test(d({ type: 'unanswered_ask' })));
assert.ok(/in the diary/.test(d({ type: 'agreed_unscheduled' })));

/* Not everything needs a note, and offering one where it does not is suggesting a
   message instead of the work. */
assert.strictEqual(d({ type: 'unprepped_meeting' }), null, 'an agenda needs writing, not mentioning');
assert.strictEqual(d({ type: 'owed_by_us', status: 'open' }), null,
  'a promise of your own that is not yet late needs doing, not announcing');
assert.ok(/still owe you/.test(d({ type: 'owed_by_us', status: 'overdue' })),
  'but once it is late, a holding note is the move');

/* A note that opens with the wrong name is worse than one that opens with none. */
assert.strictEqual(firstName('paul.oyelaran@meridianhealth.com'), 'Paul');
assert.strictEqual(firstName('DANA@northstar.io'), 'Dana', 'shouting is not a name');
assert.strictEqual(firstName('j.mercer@solstice.com'), null, 'an initial is not a name');
assert.strictEqual(firstName('hr@northstar.io'), null, 'nor is a department');
assert.strictEqual(firstName('noreply@vendor.com'), null);
assert.strictEqual(firstName('user2@x.com'), null, 'nor anything with a digit in it');

/* With no greeting the body has to start a sentence rather than continue one. */
var anon = d({ who: 'hr@northstar.io' });
assert.strictEqual(anon.indexOf('Hi '), -1, 'no greeting when there is no name');
assert.ok(/^[A-Z]/.test(anon), 'and it still reads as a sentence: ' + anon);

/* In the digest, only on the short list — one line per move, where you are about to
   act. On every item it would be clutter. */
assert.ok(/→ Hi \w+ — /.test(text), 'the note appears under the move it belongs to');

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
