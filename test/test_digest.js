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



/* --- fitting a long digest into a message that will actually send ---
 *
 * Slack refuses anything over 4,000 characters. A real mailbox goes far past it — three
 * Enron mailboxes rendered at 14k, 29k and 29k — and the runner is right to post
 * nothing rather than half a digest, so the reader would have got silence rather than a
 * long list. It never showed up against a test workspace, which produces eight items.
 *
 * The renderer does not own that limit, so capping is off unless asked for. */
var uncapped = render({ today: F.TODAY, messages: F.MESSAGES, events: F.EVENTS,
                        result: result, briefs: briefs });
var capped = render({ today: F.TODAY, messages: F.MESSAGES, events: F.EVENTS,
                      result: result, briefs: briefs, listCap: 2 });

var linesIn = function (t) {
  var body = t.split('…and ').slice(1).join('…and ') || t;
  return body.split('\n').filter(function (l) { return /^\s*\d+\. \[/.test(l); }).length;
};
assert.strictEqual(linesIn(uncapped), result.open.length,
  'with no cap asked for, every item still prints — the Slack ceiling is the runner\'s problem');
assert.ok(linesIn(capped) < linesIn(uncapped), 'a cap actually shortens the list');
assert.ok(capped.length < uncapped.length, 'and shortens the message');

/* A list that quietly stops is indistinguishable from a quiet week, which is the exact
   failure this tool exists to prevent. It has to say what it held back. */
assert.ok(/… and \d+ more in this pile/.test(capped),
  'the trim is announced with a count:\n' + capped);
var heldTotal = (capped.match(/… and (\d+) more/g) || [])
  .reduce(function (n, s) { return n + parseInt(s.match(/\d+/)[0], 10); }, 0);
assert.strictEqual(linesIn(capped) + heldTotal, result.open.length,
  'shown plus held equals the true total, so the count can be trusted');

/* Numbers are assigned over the full list, so rejecting "7" means the same thing
   whether or not the item above it was trimmed. */
assert.ok(/^\s*\d+\. \[/m.test(capped), 'capped items keep their original numbers');

/* --- conversations went in and no message came out ---
 *
 * src/slack.js parses a display format nobody documents or promises to keep, and its
 * own header says so. When that format moves the failure is total and silent: every
 * channel returns nothing at once, and the digest led with "Nothing outstanding.
 * Genuinely — the list is empty." That is an assertion of confidence, made by
 * something that could not read its input, in the one tool whose whole purpose is
 * catching what silence hides. */
var blindRun = function (msgCount, convs, unread) {
  return render({
    today: '2026-09-04', source: 'slack', listCap: 12,
    messages: new Array(msgCount).fill({}), events: [],
    result: { open: [], closed: [], dark: 0 }, briefs: [],
    ledger: { shown: [], gone: [] }, marked: 0,
    read: { threads: convs, unread: unread || [], shortRead: [], skipped: 0, windowDays: 21 }
  });
};
var blind = blindRun(0, 3);
assert.ok(/READ NOTHING/.test(blind), 'it must say it could not read anything');
assert.ok(!/Genuinely/.test(blind), 'and must not claim the list is genuinely empty');
assert.ok(/unknown rather than clear/.test(blind), 'an empty list here means unknown');

/* A genuinely quiet day still reads as one — the warning must not fire on every
   empty list, or it becomes the noise it was added to prevent. */
var quiet = blindRun(40, 3);
assert.ok(/Genuinely/.test(quiet), 'nothing outstanding is still allowed to be good news');
assert.ok(!/READ NOTHING/.test(quiet));

/* One channel empty while others parsed is a different message: it is named, and the
   headline is left alone. Both causes are stated because they are indistinguishable
   from in here and only one of them is fine. */
var partial = blindRun(12, 4, ['#legal', '#ops']);
assert.ok(/NOTHING READ IN #legal, #ops/.test(partial), 'the empty channels are named');
assert.ok(!/READ NOTHING —/.test(partial), 'but this is not a total failure');
assert.ok(!/NOTHING READ IN/.test(blind),
  'and when nothing parsed at all, the headline says it once rather than twice');

/* --- found by running it against a real Slack workspace ---
 *
 * On Slack the "subject" is the channel name, and a workspace has a handful of those.
 * The headline is the one line everybody reads, and it said "the oldest by 2 days is
 * #all-open-loops" — naming nothing that was actually late. An email subject describes
 * the thing, so it stays; on Slack the commitment is the only identifier there is. */
var headliner = function (source, what) {
  return render({
    today: '2026-09-04', source: source, listCap: 12, messages: [{}], events: [],
    result: { open: [{ type: 'owed_by_us', owner: 'you', status: 'overdue', overdueDays: 2,
                       what: what, subject: '#all-open-loops', who: '', n: 1 }],
              closed: [], dark: 0 },
    briefs: [], ledger: { shown: [], gone: [] }, marked: 0,
    read: { threads: 2, unread: [], shortRead: [], skipped: 0, windowDays: 21 }
  }).split('\n')[2];
};
var LONG = "I'm going to draft the onboarding doc and share it EOD tomorrow.";
assert.ok(/onboarding doc/.test(headliner('slack', LONG)),
  'on Slack the headline names the commitment');
assert.ok(!/#all-open-loops/.test(headliner('slack', LONG)),
  'and not the channel, which is shared by everything in it');
assert.ok(/#all-open-loops/.test(headliner('mail', LONG)),
  'a mail subject describes the thing, so it is still used');
/* A trimmed commitment already ends in an ellipsis and the sentence added a stop on
   top of it — "share it…." */
assert.ok(!/\.\.\.\.|…\./.test(headliner('slack', LONG)), 'one full stop, not two');

/* `who` falls back to the word "them", which every other move reads correctly ("Chase
   them", "Answer them") and this one does not — a bare "them — I'm going to draft the
   onboarding doc" is a placeholder printed where a name goes. */
var moveLine = function (who) {
  var out = render({
    today: '2026-09-04', source: 'slack', listCap: 12, actionList: 5,
    messages: [{}], events: [],
    result: { open: new Array(9).fill(0).map(function (_, i) {
      return { type: 'owed_by_us', owner: 'you', status: 'overdue', overdueDays: 9 - i,
               what: 'I will draft the onboarding doc.', subject: '#deals', who: who, n: i + 1 };
    }), closed: [], dark: 0 },
    briefs: [], ledger: { shown: [], gone: [] }, marked: 0,
    read: { threads: 1, unread: [], shortRead: [], skipped: 0, windowDays: 21 }
  }).split('\n');
  // The first line of the moves block. The headline quotes the same commitment, so
  // matching on the text alone picks that up instead.
  return out[out.findIndex(function (s) { return /^DO THESE FIRST/.test(s); }) + 1];
};
assert.ok(!/them —/.test(moveLine('')), 'no counterparty means no name, not "them"');
assert.ok(/lena@corp\.io —/.test(moveLine('lena@corp.io')), 'a real name still leads the line');

console.log('digest: OK');
