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

var { render, headline, digestOrder, draft, firstName, SPLIT } = require('../src/digest.js');
var F = require('../src/fixture.js');

var opts = { exec: F.EXEC, today: F.TODAY, contacts: F.RELATIONSHIPS };
var result = loops.detectLoops(F.MESSAGES, F.EVENTS, opts);
var briefs = loops.meetingBriefs(F.MESSAGES, F.EVENTS, result.open, opts);
var keys = digestOrder(result.open, F.TODAY);

var text = render({
  today: F.TODAY, source: 'gmail',
  messages: F.MESSAGES, events: F.EVENTS, result: result, briefs: briefs,
  ledger: { fresh: 15, suppressed: 0, gone: [] },
  read: { threads: 18, capped: false, cap: '300-thread' },
  marked: 0
});
var parts = function (t) { var i = t.indexOf(SPLIT); return { brief: t.slice(0, i), details: t.slice(i + SPLIT.length) }; };
var ROW = /^ ?\d+  \S/;
var rows = function (t) { return t.split('\n').filter(function (l) { return ROW.test(l); }); };
var brief = parts(text).brief, details = parts(text).details;

assert.ok(text.indexOf('OPEN LOOPS — for ' + F.TODAY) === 0, 'the date comes off the object, not a clock');
assert.ok(text.indexOf(SPLIT) > 0, 'two parts: the brief, then the details for its thread');
assert.ok(details.indexOf('Read 25 messages across 18 threads and 5 meetings.') > -1, 'what was read is in the details');
assert.ok(details.indexOf('CHASE THEM') > -1, 'the owner piles are in the details');
assert.ok(!/undefined|NaN|\[object/.test(text), 'nothing leaked through as undefined');
assert.ok(/^\s*OPEN LOOPS DETAILS/.test(details.trim()), 'the details open with a header the reply parser ignores');

/* --- numbering is what a reply quotes back, so it has to be exact --- */
assert.strictEqual(keys.length, result.open.length, 'every open item gets a number');

// The brief, in the order it reads: TODAY, then the one-liners. Numbers run 1..k.
var bRows = rows(brief);
assert.strictEqual(bRows.length, Math.min(8, result.open.length), 'three in TODAY, five below: ' + bRows.length);
bRows.forEach(function (line, i) {
  assert.strictEqual(parseInt(line, 10), i + 1, 'the brief numbers in reading order: ' + line);
});
assert.ok(new RegExp('\\+ ' + (result.open.length - 8) + ' more').test(brief), 'and says how many it left for the thread');

// The details hold every item, each once.
var dNums = rows(details).map(function (l) { return parseInt(l, 10); }).sort(function (a, b) { return a - b; });
assert.deepStrictEqual(dNums, keys.map(function (_, i) { return i + 1; }), 'every item, once, in the details');

/* --- the headline, now only for an empty list, in each of its four states --- */
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

/* --- TODAY: what to do next --- */
var today = brief.split('TODAY — highest priority')[1].split('\n\n')[0];
assert.strictEqual(rows(today).length, 3, 'three items in TODAY');
assert.ok(/Send an agenda —|Chase |Answer |You owe |Needs /.test(today), 'each names the move, not just the sentence');
assert.ok(rows(today).every(function (l) { return l.length <= 100; }),
  'no TODAY line runs on: ' + rows(today).filter(function (l) { return l.length > 100; }).join(' | '));

// Every loop appears once in the brief.
var bNums = bRows.map(function (l) { return parseInt(l, 10); });
assert.strictEqual(new Set(bNums).size, bNums.length, 'no item twice in the brief');

/* --- what to do first: the order, on items built to test it --- */
var T = '2026-09-16';
var it = function (id, over) {
  var l = { type: 'owed_by_us', owner: 'you', status: 'open', what: id, subject: '#a' };
  Object.keys(over).forEach(function (k) { l[k] = over[k]; });
  return l;
};
var order = function (items) {
  var copy = items.slice();
  digestOrder(copy, T);
  return copy.sort(function (a, b) { return a.n - b.n; }).map(function (l) { return l.what; });
};
assert.deepStrictEqual(order([
  it('rest', {}),
  it('old', { status: 'overdue', overdueDays: 14, due: '2026-09-02' }),
  it('waiting', { type: 'unanswered_ask' }),
  it('soon-fri', { due: '2026-09-18' }),
  it('today', { status: 'due_today', due: '2026-09-16' }),
  it('borrowed', { status: 'overdue', overdueDays: 1, due: '2026-09-15', dueFrom: { same: false } }),
  it('arrived', { status: 'overdue', overdueDays: 2, due: '2026-09-14' })
]), ['arrived', 'today', 'soon-fri', 'waiting', 'old', 'borrowed', 'rest'],
  'just-arrived deadline, due soon (earliest first), someone waiting, other overdue, the rest');
assert.deepStrictEqual(order([
  it('mine', { status: 'overdue', overdueDays: 2, due: '2026-09-14' }),
  it('theirs', { type: 'unanswered_ask', status: 'overdue', overdueDays: 2, due: '2026-09-14' })
]), ['theirs', 'mine'], 'within a group, somebody waiting on you first');
assert.deepStrictEqual(order([
  it('a', { type: 'unanswered_ask', who: 'sam@a.io', status: 'overdue', overdueDays: 1, due: '2026-09-15' }),
  it('b', { type: 'owed_to_us', owner: 'them', who: 'sam@a.io', status: 'due_today', due: '2026-09-16' }),
  it('c', { type: 'unanswered_ask', who: 'sam@a.io', due: '2026-09-17' })
]), ['a', 'b', 'c'], 'and no cap per person — three urgent things from Sam are three');

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

/* The brief says what to do; the details say what you could say — and only for what is
   in TODAY, where you are about to act. On every item it would be clutter. */
assert.strictEqual(brief.indexOf('→ '), -1, 'no drafts in the brief');
assert.ok(/→ Hi \w+ — /.test(details), 'they are in the details');
var drafted = details.split('\n').map(function (l, i, all) {
  return /^\s+→ /.test(l) ? parseInt(all.slice(0, i).reverse().filter(function (x) { return ROW.test(x); })[0], 10) : null;
}).filter(function (n) { return n; });
assert.ok(drafted.every(function (n) { return n <= 3; }), 'and only under TODAY\'s items: ' + drafted.join(','));

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
assert.ok(/1 read warning — in the thread\./.test(parts(capped).brief),
  'the brief counts the warning; the details carry it');

/* --- fitting a long digest into a message that will actually send ---
 *
 * Slack refuses anything over 4,000 characters. A real mailbox goes far past it — three
 * Enron mailboxes rendered at 14k, 29k and 29k — and the runner is right to post
 * nothing rather than half a digest. The renderer does not own that limit, so capping
 * is off unless asked for, and it only ever trims the details: the brief is bounded. */
var uncapped = render({ today: F.TODAY, messages: F.MESSAGES, events: F.EVENTS,
                        result: result, briefs: briefs });
var cappedFx = render({ today: F.TODAY, messages: F.MESSAGES, events: F.EVENTS,
                        result: result, briefs: briefs, listCap: 2 });
var detailRows = function (t) { return rows(parts(t).details).length; };
assert.strictEqual(detailRows(uncapped), result.open.length,
  'with no cap asked for, every item still prints — the Slack ceiling is the runner\'s problem');
assert.ok(detailRows(cappedFx) < detailRows(uncapped), 'a cap actually shortens the list');
assert.ok(/… and \d+ more in this pile/.test(cappedFx), 'the trim is announced with a count');
var heldTotal = (parts(cappedFx).details.match(/… and (\d+) more/g) || [])
  .reduce(function (n, s) { return n + parseInt(s.match(/\d+/)[0], 10); }, 0);
assert.strictEqual(detailRows(cappedFx) + heldTotal, result.open.length,
  'shown plus held equals the true total, so the count can be trusted');
assert.strictEqual(parts(cappedFx).brief, parts(uncapped).brief, 'and the brief is untouched by it');

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
assert.ok(/READ NOTHING/.test(parts(blind).brief), 'it must say it could not read anything, in the brief');
assert.ok(!/Genuinely/.test(blind), 'and must not claim the list is genuinely empty');
assert.ok(/unknown rather than clear/.test(blind), 'an empty list here means unknown');

/* A genuinely quiet day still reads as one — the warning must not fire on every
   empty list, or it becomes the noise it was added to prevent. */
var quiet = blindRun(40, 3);
assert.ok(/Genuinely/.test(quiet), 'nothing outstanding is still allowed to be good news');
assert.ok(!/READ NOTHING/.test(quiet));

/* One channel empty while others parsed is a different message: it is named, and the
   headline is left alone. */
var partial = blindRun(12, 4, ['#legal', '#ops']);
assert.ok(/NOTHING READ IN #legal, #ops/.test(parts(partial).details), 'the empty channels are named');
assert.ok(!/READ NOTHING —/.test(partial), 'but this is not a total failure');
assert.ok(!/NOTHING READ IN/.test(blind),
  'and when nothing parsed at all, it is said once rather than twice');

/* --- found by running it against a real Slack workspace ---
 *
 * On Slack the "subject" is the channel name, and a workspace has a handful of those.
 * The line everybody reads once said "the oldest by 2 days is #all-open-loops" — naming
 * nothing that was actually late. TODAY names the commitment; where it was said goes on
 * the line beneath. */
var spotlight = function (what) {
  var out = parts(render({
    today: '2026-09-04', source: 'slack', listCap: 12, messages: [{}], events: [],
    result: { open: [{ type: 'owed_by_us', owner: 'you', status: 'overdue', overdueDays: 2,
                       what: what, subject: '#all-open-loops', who: '', n: 1 }],
              closed: [], dark: 0 },
    briefs: [], ledger: { shown: [], gone: [] }, marked: 0,
    read: { threads: 2, unread: [], shortRead: [], skipped: 0, windowDays: 21 }
  })).brief.split('\n');
  var i = out.indexOf('TODAY — highest priority');
  return { row: out[i + 1], meta: out[i + 2] };
};
var LONG = "I'm going to draft the onboarding doc and share it EOD tomorrow.";
assert.ok(/onboarding doc/.test(spotlight(LONG).row), 'TODAY names the commitment');
assert.ok(!/#all-open-loops/.test(spotlight(LONG).row), 'and not the channel, which everything in it shares');
assert.ok(/#all-open-loops/.test(spotlight(LONG).meta), 'which goes underneath, as where it was said');
assert.ok(!/\.\.\.\.|…\./.test(spotlight(LONG).row), 'one full stop, not two');

/* `who` can be empty, and "them — I'm going to draft the onboarding doc" is a
   placeholder printed where a name goes. */
var moveLine = function (who) {
  var out = render({
    today: '2026-09-04', source: 'slack', listCap: 12,
    messages: [{}], events: [],
    result: { open: new Array(9).fill(0).map(function (_, i) {
      return { type: 'owed_by_us', owner: 'you', status: 'overdue', overdueDays: 9 - i,
               what: 'I will draft the onboarding doc.', subject: '#deals', who: who, n: i + 1 };
    }), closed: [], dark: 0 },
    briefs: [], ledger: { shown: [], gone: [] }, marked: 0,
    read: { threads: 1, unread: [], shortRead: [], skipped: 0, windowDays: 21 }
  }).split('\n');
  return out[out.indexOf('TODAY — highest priority') + 1];
};
assert.ok(!/them —/.test(moveLine('')), 'no counterparty means no name, not "them"');
assert.ok(/You owe Lena — /.test(moveLine('lena@corp.io')), 'a real person is named: ' + moveLine('lena@corp.io'));

/* --- the redesign's own rules --- */
var one = function (b) {
  var base = { today: '2026-09-16', source: 'slack', messages: [], events: [], briefs: [],
               result: { open: [], closed: [] } };
  Object.keys(b).forEach(function (k) { base[k] = b[k]; });
  return render(base);
};
var item = function (over) {
  var l = { type: 'owed_by_us', owner: 'you', status: 'open', what: 'x', subject: '#a', n: 1 };
  Object.keys(over).forEach(function (k) { l[k] = over[k]; });
  return l;
};

// Dates as a reader says them: a weekday within the week, a date beyond it.
var dated = parts(one({ result: { open: [item({ due: '2026-09-17' }), item({ n: 2, due: '2026-10-02', what: 'y' })], closed: [] } })).brief;
assert.ok(/^OPEN LOOPS — for 2026-09-16 · Wed$/m.test(dated), 'the header keeps the date replies are matched on');
assert.ok(/^ 1  Thu\s+You promised — "x"$/m.test(dated) && /^ 2  2 Oct\s+You promised — "y"$/m.test(dated),
  'Thu this week, 2 Oct beyond it:\n' + dated);

// NEW only when it tells you something.
var tagged = function (fresh) {
  return one({ ledger: { fresh: fresh, suppressed: 0, gone: [] }, result: { open: [
    item({ isNew: true }),
    item({ n: 2, what: 'y', isNew: fresh === 2, trackedDays: fresh === 2 ? 0 : 3 })
  ], closed: [] } });
};
assert.ok(!/NEW|\d new/.test(tagged(2)), 'when everything is new, nothing is marked new');
assert.ok(/NEW/.test(tagged(1)) && /· 1 new/.test(tagged(1)) && /3d on the list/.test(tagged(1)),
  'on a mixed day the new one is marked and the old one says how long it has sat');

// The reply key is always on the brief; the full explanation is in the details until
// the reader has answered once.
assert.ok(/^Reply  3 7 not real · k 1 4 already knew/m.test(parts(one({})).brief), 'the key is on the brief');
assert.ok(/isn't real/.test(parts(one({})).details), 'the full explanation is in the details by default');
assert.ok(!/isn't real/.test(one({ replyKey: 'short' })), 'and gone once the reader knows it');

// People by the name they go by — unless two share it.
var ask = function (who, n) { return item({ type: 'unanswered_ask', what: 'Can you check?', who: who, n: n }); };
var named = one({ messages: [{ from: 's1@a.io', fromName: 'Sam M' }],
  result: { open: [ask('s1@a.io', 1), ask('lee@a.io', 2)], closed: [] } });
assert.ok(/Answer Sam — /.test(named) && /Lee asked: "Can you check\?"/.test(named),
  'the display name, then a name off the address:\n' + named);
var twoSams = one({ messages: [{ from: 's1@a.io', fromName: 'Sam M' }, { from: 's2@b.io', fromName: 'Sam K' }],
  result: { open: [ask('s1@a.io', 1), ask('s2@b.io', 2)], closed: [] } });
assert.ok(!/Sam/.test(twoSams) && /s2@b\.io asked/.test(twoSams), 'two Sams keep their addresses');

// The evidence: where a borrowed date came from, and what closed something.
var why = one({ result: { open: [
  item({ type: 'unanswered_ask', who: 'sam@a.io', what: 'Are we still on?', status: 'overdue', overdueDays: 2, due: '2026-09-14',
         dueFrom: { text: 'I need an answer today.', from: 'sam@a.io', same: true } }),
  item({ n: 2, what: "I'll circulate the redline.", status: 'overdue', overdueDays: 1, due: '2026-09-15',
         dueFrom: { text: "I'll get you the signed MSA back by Tuesday.", from: 'lena@a.io', same: false } })
], closed: [
  { type: 'closed', openType: 'owed_to_us', who: 'lena@a.io', what: "I'll get you the signed MSA back by Tuesday.",
    closedOn: '2026-09-14', closedBy: 'Signed MSA attached.', closedByWho: 'lena@a.io' }
] } });
assert.ok(/· "I need an answer today"/.test(why), 'a deadline from the next sentence is quoted');
assert.ok(/date from Lena's "by Tuesday"/.test(why), 'one from somebody else says whose');
assert.ok(/^    Lena: "I'll get you the signed MSA back by Tuesday\."$/m.test(parts(why).details) &&
  /^      closed Mon by Lena: "Signed MSA attached\."$/m.test(parts(why).details),
  'and a closed item says what closed it, in the details:\n' + why);
assert.ok(/\+ 1 closed in the thread ↓/.test(parts(why).brief), 'the brief points at it');

console.log('digest: OK');
