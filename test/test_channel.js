/* A channel is not one relationship.
 *
 * The first run with more than one other person in it (2026-09-14) found three rules that
 * all assumed it was: a channel tracked one question, decided by whoever posted last; the
 * reader's own "I'll…" went to the executive's pile whenever they supported someone; and
 * every item in a channel was attributed to whoever spoke first, tier included — even
 * promises made before that person joined. Conversation, ownership and attribution are
 * now decided per message and per commitment. Each rule is checked in both directions,
 * because a fix verified one way has hidden the other before.
 */
var assert = require('assert');
var { detectLoops } = require('../src/loops.js');

var ME = 'me@corp.io', SAM = 'sam@vector.io', LENA = 'lena@vector.io';
var n = 0;
// A channel read: a stream, with the display name the adapter carries.
var say = function (from, time, body, extra) {
  var name = { 'me@corp.io': 'Alex Rivera', 'sam@vector.io': 'Sam M', 'lena@vector.io': 'Lena H' }[from];
  return Object.assign({ id: String(++n), threadId: '#vector', subject: '#vector', stream: true,
    from: from, fromName: name, to: [], date: '2026-09-' + time, attach: false, body: body }, extra || {});
};
// The same messages as a real Slack thread: reply structure, no stream flag.
var threaded = function (msgs) {
  return msgs.map(function (m) { return Object.assign({}, m, { threadId: 'T1', stream: false }); });
};
var run = function (msgs, principals) {
  return detectLoops(msgs, [], { exec: ME, today: '2026-09-18', principals: principals || [],
    contacts: { 'vector.io': { tier: 'key_account', label: 'Vector' } } }).open;
};
var of = function (open, type) { return open.filter(function (l) { return l.type === type; }); };

/* ---------------- 1. each question stands alone ---------------- */

var kickoff = say(SAM, '14T10:00', 'Are we still on for the vendor kickoff?');

// Inbound, then the reader says something unrelated in the same channel.
var asks = of(run([kickoff, say(ME, '14T10:05', "I'll book the pricing review before end of week.")]), 'unanswered_ask');
assert.strictEqual(asks.length, 1, 'an unrelated message from the reader does not answer Sam');
assert.strictEqual(asks[0].who, SAM);

// Inbound, answered on topic.
assert.strictEqual(of(run([kickoff, say(ME, '14T10:05', 'Yes — the vendor kickoff is still on for Tuesday.')]),
  'unanswered_ask').length, 0, 'an answer that is about the question closes it');

// Two people, two questions, one channel: both tracked; answering one leaves the other.
var pilot = say(LENA, '14T10:02', 'Can you confirm the pilot start date?');
assert.strictEqual(of(run([kickoff, pilot]), 'unanswered_ask').length, 2, 'a channel holds more than one question');
var left = of(run([kickoff, pilot, say(ME, '14T10:10', 'Pilot start date is the 22nd.')]), 'unanswered_ask');
assert.deepStrictEqual(left.map(function (l) { return l.who; }), [SAM], 'answering Lena leaves Sam open');

// The same person following up on the same topic does not answer themselves.
assert.strictEqual(of(run([kickoff, say(SAM, '14T11:00', 'Also — any update on the kickoff venue?')]),
  'unanswered_ask').length, 2, 'a message from the asking side never answers the ask');

// Outbound: a shared generic word is not an answer ("plan" and "plan").
var plan = say(ME, '14T10:00', 'Lena, can you review the Q4 headcount plan?');
var waiting = of(run([say(LENA, '13T09:00', 'Morning.'), plan,
  say(LENA, '14T10:30', "Let's walk through the rollout plan Thursday.")]), 'awaiting_reply');
assert.strictEqual(waiting.length, 1, '"plan" and "plan" do not make an answer');
assert.strictEqual(waiting[0].who, LENA, 'and the ask is Lena\'s, because it was put to her by name');

// Outbound, answered on topic by the other side.
assert.strictEqual(of(run([say(ME, '14T10:00', 'Lena, can you confirm the pilot start date?'),
  say(LENA, '14T10:30', 'The pilot start date is the 22nd.')]), 'awaiting_reply').length, 0,
  'an on-topic answer from the other side closes our ask');

// A real thread keeps whose-turn: its next message from the other side is the answer.
assert.strictEqual(of(run(threaded([kickoff, say(ME, '14T10:05', "I'll book the pricing review before end of week.")])),
  'unanswered_ask').length, 0, 'in a thread, the reader replying is the reply');
assert.strictEqual(of(run(threaded([say(ME, '14T10:00', 'Can you confirm the pilot start date?'),
  say(LENA, '14T10:30', 'Sounds good.')])), 'awaiting_reply').length, 0, 'and so is theirs');

/* ---------------- 2. first person is the reader's ---------------- */

var DANA = [{ label: 'Dana', address: 'dana@corp.io' }];
var promise = function (from, body, principals) {
  return of(run([say(from, '14T10:00', body)], principals), from === ME ? 'owed_by_us' : 'owed_to_us')[0];
};
assert.strictEqual(promise(ME, "I'll review the agenda before Monday.", DANA).owner, 'you',
  'the reader reviewing is the reader\'s, even with a verb that used to mean the executive');
assert.strictEqual(promise(ME, "I'm going to draft the onboarding doc by Friday.", DANA).owner, 'you');
assert.strictEqual(promise(ME, "I'll get Dana's sign-off on the budget by Friday.", DANA).owner, 'you',
  'getting the executive\'s sign-off is the reader\'s job, though it names her');
var relayed = promise(ME, 'Dana will send the signed copy Friday.', DANA);
assert.strictEqual(relayed.owner, 'exec', 'a promise in the executive\'s name is the executive\'s');
assert.strictEqual(relayed.principal.label, 'Dana');
var third = promise(ME, 'Sarah will send the contract Friday.', DANA);
assert.strictEqual(third.owner, 'them', 'and one in a third party\'s name is theirs');
assert.strictEqual(third.who, 'Sarah', 'chased with that person');
assert.strictEqual(third.rel, null, 'with no tier borrowed from the channel');
var theirs = promise(SAM, "I'll send the redlines Friday.", DANA);
assert.strictEqual(theirs.owner, 'them', 'inbound, their "I\'ll" is theirs');
assert.strictEqual(theirs.who, SAM);

/* ---------------- 3. attribution needs evidence ---------------- */

var mine = function (msgs) { return of(run(msgs), 'owed_by_us')[0]; };
var early = say(LENA, '14T09:00', 'Numbers came in a bit under forecast.');

var none = mine([early, say(ME, '14T11:00', "I'll send the scope doc to finance Friday.")]);
assert.strictEqual(none.who, null, 'the first person to speak is not the one every promise was made to');
assert.strictEqual(none.rel, null, 'and an unattributed item carries no tier');

var addressed = mine([say(SAM, '14T09:00', 'Morning.'), say(ME, '14T11:00', "Sam, I'll send the deck Friday.")]);
assert.strictEqual(addressed.who, SAM, 'addressed by name, it is theirs');
assert.strictEqual(addressed.rel && addressed.rel.label, 'Vector', 'and carries their tier');

assert.strictEqual(mine([early, say(ME, '14T11:00', "Priya, I'll send the deck Friday.")]).who, null,
  'a name nobody in the channel answers to is not turned into somebody who is');

var topical = mine([say(SAM, '14T10:00', 'Can we get the vendor contract before Tuesday?'),
  say(ME, '14T10:10', "I'll send the vendor contract Friday.")]);
assert.strictEqual(topical.who, SAM, 'same day and on the topic someone just raised: theirs');

assert.strictEqual(mine([say(SAM, '13T10:00', 'Can we get the vendor contract before Tuesday?'),
  say(ME, '14T10:10', "I'll send the vendor contract Friday.")]).who, null, 'a day later, no longer evidence');

assert.strictEqual(mine([say(SAM, '14T10:00', 'Can we sync on the plan?'),
  say(ME, '14T10:10', "I'll send the plan Friday.")]).who, null, 'generic overlap is not a topic');

var ask = of(run([early, say(ME, '14T11:00', 'Can you confirm the pilot date?')]), 'awaiting_reply')[0];
assert.strictEqual(ask.who, null, 'an ask put to nobody in particular is put to nobody');
assert.strictEqual(ask.rel, null);

// A real thread is one conversation, so its participant is the counterparty.
var inThread = of(run(threaded([early, say(ME, '14T11:00', "I'll send the scope doc to finance Friday.")])), 'owed_by_us')[0];
assert.strictEqual(inThread.who, LENA, 'in a thread, the other participant is who it was said to');

// A conversation that declares one other member is a DM with them. Two is a channel.
var dm = function (members, extra) {
  return mine((extra || []).concat([say(ME, '14T11:00', "I'll send the scope doc Friday.", { to: members })])).who;
};
assert.strictEqual(dm([LENA]), LENA, 'the only other member of a conversation is who it was said to');
assert.strictEqual(dm([LENA, SAM]), null, 'but a conversation with two others names neither');
assert.strictEqual(dm([LENA], [say(SAM, '14T09:00', 'Morning.', { to: [LENA] })]), null,
  'and a member list someone else has spoken past is not trusted');

/* ---------------- 4. a question's deadline is often the next sentence ---------------- */

// "Are we still on for the vendor kickoff? I need an answer today." — seed item 9, undated
// on the real run, and so ranked on age below things that mattered less.
var askOf = function (msgs, type) { return of(run(msgs), type)[0]; };
var inDue = function (body, thread) {
  var m = [say(SAM, '14T10:00', body)];
  return askOf(thread ? threaded(m) : m, 'unanswered_ask').due;
};
assert.strictEqual(inDue('Are we still on for the vendor kickoff? I need an answer today.'), '2026-09-14',
  'inbound: the deadline in the next sentence dates the question');
assert.strictEqual(inDue('Are we still on for the vendor kickoff? I need an answer today.', true), '2026-09-14',
  'and the same in a real thread');
assert.strictEqual(inDue('Can you review the deck? I am out Friday.'), null,
  'a date that is not a deadline dates nothing');
assert.strictEqual(inDue("Can you review the deck? We'll send the rest by Friday."), null,
  'nor does a promise sitting beside the question — that deadline is the promise\'s');

var outDue = function (body, thread) {
  var m = [say(ME, '14T10:00', body)];
  return askOf(thread ? threaded(m) : m, 'awaiting_reply').due;
};
assert.strictEqual(outDue('Lena, can you send the signed copy? I need it by Friday.'), '2026-09-18',
  'outbound: our stated deadline dates our ask');
assert.strictEqual(outDue('Can you send the signed copy? I need it by Friday.', true), '2026-09-18',
  'and the same in a real thread');
assert.strictEqual(outDue('Lena, does Thursday work for a call?'), null,
  'but a date in our own question is a proposed slot, not a deadline');

/* ---------------- 5. held back is not the same as found nothing ---------------- */
var hold = function (msgs) { return detectLoops(msgs, [], { exec: ME, today: '2026-09-18', principals: [] }).held; };
assert.deepStrictEqual(hold([say(SAM, '17T10:00', 'Are we still on for the vendor kickoff?')]), [String(n)],
  'inbound: a question too young to raise is reported as held');
assert.deepStrictEqual(hold(threaded([say(ME, '17T10:00', 'Can you confirm the pilot date?')])), [String(n)],
  'outbound, in a thread: the same');
assert.deepStrictEqual(hold(threaded([say(SAM, '17T10:00', 'Are we still on for the vendor kickoff?')])), [String(n)],
  'inbound, in a thread: the same');
assert.deepStrictEqual(hold([say(SAM, '14T10:00', 'Are we still on for the vendor kickoff?')]), [],
  'and one old enough to raise is raised, not held');

/* ---------------- 6. a stated deadline beats the two-day grace ---------------- */
// Tuesday's real run (2026-09-15) held "…I need an answer today." for its two days, so
// an overdue question from a key account did not appear at all.
var raised = function (msgs, type) { return of(run(msgs), type).length; };
assert.strictEqual(raised([say(SAM, '17T10:00', 'Are we still on for the vendor kickoff? I need an answer today.')], 'unanswered_ask'), 1,
  'inbound: a day old and past its stated deadline — raised');
assert.strictEqual(raised([say(SAM, '18T09:00', 'Can you confirm the pilot date? I need an answer today.')], 'unanswered_ask'), 1,
  'and on the day itself');
assert.strictEqual(raised([say(SAM, '17T10:00', 'Can you confirm the pilot date by Friday?')], 'unanswered_ask'), 1,
  'a deadline in the question counts once it arrives');
assert.strictEqual(raised([say(SAM, '17T10:00', 'Can you confirm the pilot date by Monday?')], 'unanswered_ask'), 0,
  'but not before');
assert.strictEqual(raised([say(SAM, '17T10:00', 'Can you confirm the pilot date?')], 'unanswered_ask'), 0,
  'an undated question still gets its two days');
assert.strictEqual(raised([say(ME, '17T10:00', 'Lena, does Friday work for a call?')], 'awaiting_reply'), 0,
  'outbound: a day in our own question is a slot, not a deadline');
assert.strictEqual(raised([say(ME, '17T10:00', 'Lena, can you send the signed copy? I need it by Friday.')], 'awaiting_reply'), 1,
  'but a deadline we stated is one');
assert.strictEqual(raised(threaded([say(SAM, '17T10:00', 'Are we still on for the vendor kickoff? I need an answer today.')]), 'unanswered_ask'), 1,
  'in a thread, inbound');
assert.strictEqual(raised(threaded([say(ME, '17T10:00', 'Can you send the signed copy? I need it by Friday.')]), 'awaiting_reply'), 1,
  'in a thread, outbound');

console.log('test_channel: ok');
