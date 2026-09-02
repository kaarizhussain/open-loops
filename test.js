var assert = require('assert');
var { detectLoops, meetingBriefs, parseDue, LABEL, OWNER } = require('./src/loops.js');
var F = require('./src/fixture.js');

/* date parsing */
assert.strictEqual(parseDue('by Friday Aug 1 at the latest', '2026-07-28T14:12'), '2026-08-01');
assert.strictEqual(parseDue("I'll send it Thursday EOD", '2026-08-03T17:22'), '2026-08-06');
assert.strictEqual(parseDue('questionnaire tomorrow', '2026-07-30T13:00'), '2026-07-31');
assert.strictEqual(parseDue('connect you with Sana this week', '2026-07-30T18:02'), '2026-07-31');
assert.strictEqual(parseDue('no deadline mentioned here', '2026-08-01T10:00'), null);

/* ---- ordinals ----
 *
 * "Aug 15th" and "Sept 3rd" used to match nothing, because the month rule demanded a
 * word boundary straight after the digits and "15th" has none. Those are commoner than
 * the bare form, and they arrived silently undated — a promise with no deadline sinks
 * to the bottom of the list rather than announcing that its date was dropped. */
assert.strictEqual(parseDue('Aug 15th', '2026-08-01T10:00'), '2026-08-15');
assert.strictEqual(parseDue('by Sept 3rd', '2026-09-01T10:00'), '2026-09-03');
assert.strictEqual(parseDue('Aug 15', '2026-08-01T10:00'), '2026-08-15', 'and the bare form still works');

/* A day with no month means the next one to come round. */
assert.strictEqual(parseDue('by the 15th', '2026-09-01T10:00'), '2026-09-15');
assert.strictEqual(parseDue('by the 1st', '2026-09-15T10:00'), '2026-10-01', 'already gone, so next month');
assert.strictEqual(parseDue('due the 30th', '2026-09-01T10:00'), '2026-09-30');

/* The ordinal suffix is required, because it is the only thing separating a date from
   a quantity — and some ordinals are not dates at all. */
assert.strictEqual(parseDue('I have 15 emails to get through', '2026-09-01T10:00'), null);
['we are on the 3rd floor', 'happy with the 2nd option', 'let us discuss in the 4th quarter']
  .forEach(function (s) {
    assert.strictEqual(parseDue(s, '2026-09-01T10:00'), null, 'not a date: ' + s);
  });

var r = detectLoops(F.MESSAGES, F.EVENTS, { exec: F.EXEC, today: F.TODAY, contacts: F.RELATIONSHIPS });
var find = function (sub, type) {
  return r.open.filter(function (l) { return l.subject.indexOf(sub) > -1 && (!type || l.type === type); })[0];
};

/* closure detection: delivered promises must NOT appear as open */
assert.ok(!find('Cedarline'), 'Cedarline pricing was delivered — should not be open');
assert.ok(!find('Northwind expansion'), 'security questionnaire was delivered — should not be open');
assert.ok(r.closed.length >= 3, 'expected delivered promises in cleared list, got ' + r.closed.length);

/* the overdue inbound promise */
var mer = find('Meridian', 'owed_to_us');
assert.ok(mer, 'Meridian redlines promise not detected');
assert.strictEqual(mer.due, '2026-07-31');
assert.strictEqual(mer.status, 'overdue');
assert.strictEqual(mer.overdueDays, 6);

/* ---- weekend deadlines are really Friday deadlines ---- */
var comp2 = find('comp plan', 'owed_by_us');
assert.strictEqual(comp2.due, '2026-08-08', 'the stated date is preserved');
assert.strictEqual(comp2.workDue, '2026-08-07', 'Saturday resolves back to the Friday before');
assert.strictEqual(comp2.weekendShift, true);
assert.strictEqual(mer.weekendShift, false, 'a Friday deadline is not shifted');
assert.strictEqual(mer.workDue, mer.due);
assert.ok(r.open.every(function (l) {
  if (!l.workDue) return true;
  var d = new Date(l.workDue + 'T00:00:00Z').getUTCDay();
  return d !== 0 && d !== 6;
}), 'no working deadline may land on a weekend');

/* the promise due today */
var deck = find('board deck', 'owed_by_us');
assert.ok(deck, 'board deck promise not detected');
assert.strictEqual(deck.due, '2026-08-06');
assert.strictEqual(deck.status, 'due_today');

/* agreed but never put on the calendar */
var ref = find('Reference call', 'agreed_unscheduled');
assert.ok(ref, 'reference call should be flagged as agreed-but-unbooked');

/* inbound ask nobody answered — and its stated deadline has passed */
var summit = find('RevOps Summit', 'unanswered_ask');
assert.ok(summit, 'unanswered speaker request not detected');
assert.strictEqual(summit.due, '2026-08-05');
assert.strictEqual(summit.status, 'overdue');

/* a promise with no date of its own inherits the deadline it was answering */
var comp = find('comp plan', 'owed_by_us');
assert.ok(comp, 'comp plan sign-off not detected');
assert.strictEqual(comp.due, '2026-08-08', 'should inherit "by Aug 8" from the request');

/* ---- "let's" is a commitment when it schedules something ----
 *
 * Chat leans on it far more than mail does — "let's set up a call Thursday" is an
 * agreement somebody now has to act on, and it was going undetected entirely. But most
 * uses of the word are discourse, so it is allow-listed against verbs rather than
 * opened up: let's see, let's be honest, let's not get ahead of ourselves. */
var lets = function (body) {
  return detectLoops([{ id: 'x', threadId: 'z', subject: 'Thread', from: F.EXEC,
    to: ['x@acme.com'], date: '2026-08-03T09:00', attach: false, body: body }],
    [], { exec: F.EXEC, today: F.TODAY }).open;
};
assert.strictEqual(lets("Let's schedule a sync for Thursday to walk through the rollout.").length, 1,
  'an agreement to meet is a commitment somebody has to act on');
assert.strictEqual(lets("Let's set up a call next week about the pilot.").length, 1);
['Let\'s see how the numbers land.', "Let's be honest, that timeline was never real.",
 "Let's not get ahead of ourselves.", 'Great work everyone, let\'s go.'].forEach(function (b) {
  assert.strictEqual(lets(b).length, 0, 'discourse, not a commitment: ' + b);
});

/* One agreement stated twice in one message is one item. A "let's" after your own
   commitment is elaboration; a separate second commitment says "I'll" again. */
assert.strictEqual(lets("Sure — I'll do the call. Tuesday works, let's find time.").length, 1,
  'the same agreement restated must not appear twice');
assert.strictEqual(lets("I'll send the deck today. I'll also book the room.").length, 2,
  'but two genuine commitments in one message are two items');

/* an outbound proposed date is not a deadline */
var iron = find('Ironwood', 'awaiting_reply');
assert.ok(iron && iron.due === null, 'proposed meeting slot should not become a due date');

/* meeting tomorrow with no agenda, and one today */
assert.ok(find('Vector Freight', 'unprepped_meeting'), 'QBR has no agenda — should flag');
assert.ok(find('Larkspur', 'unprepped_meeting'), 'call today has no agenda — should flag');
assert.ok(!find('Cobalt', 'unprepped_meeting'), 'Cobalt had an agenda');
assert.ok(!find('Weekly revenue staff'), 'internal-only meeting should not flag');
assert.ok(!find('Northwind — expansion kickoff'), 'agenda present and 5 days out');

/* ---- ownership split ---- */
assert.strictEqual(find('Meridian', 'owed_to_us').owner, 'them', 'their unmet promise is a chase');
assert.strictEqual(find('Ironwood', 'awaiting_reply').owner, 'them', 'unanswered question is a chase');
assert.strictEqual(find('board deck', 'owed_by_us').owner, 'exec', 'only the exec writes the revenue section');
assert.strictEqual(find('comp plan', 'owed_by_us').owner, 'exec', 'sign-off cannot be delegated');
assert.strictEqual(find('offsite', 'owed_by_us').owner, 'you', 'booking a venue is the assistant\'s');
assert.strictEqual(find('RevOps Summit', 'unanswered_ask').owner, 'you', 'a bio and talk title can be drafted');
assert.strictEqual(find('Vector Freight', 'unprepped_meeting').owner, 'you', 'agendas are logistics');
assert.strictEqual(find('Reference call', 'agreed_unscheduled').owner, 'you',
  'the exec takes the call, but booking it is the next action');
assert.strictEqual(find('Cobalt', 'no_followup').owner, 'you', 'sending a recap is logistics');
['them', 'you', 'exec'].forEach(function (o) {
  assert.ok(r.open.some(function (l) { return l.owner === o; }), 'no items in pile: ' + o);
  assert.ok(OWNER[o] && OWNER[o].title, 'missing label for pile: ' + o);
});

/* ---- who you support: nobody, one person, or several ----
 *
 * The three-way split assumes two people. Someone running this over their own work
 * is one person, and sorting their work into "yours" and "the executive's" produces
 * a heading that lies about what is under it. */
var base = { exec: F.EXEC, today: F.TODAY, contacts: F.RELATIONSHIPS };
var withP = function (principals) {
  var o = { exec: base.exec, today: base.today, contacts: base.contacts };
  if (principals !== undefined) o.principals = principals;
  return detectLoops(F.MESSAGES, F.EVENTS, o);
};

/* Passing nothing must behave exactly as it did before this existed. */
var unchanged = withP(undefined);
assert.strictEqual(unchanged.open.filter(function (l) { return l.owner === 'exec'; }).length,
  r.open.filter(function (l) { return l.owner === 'exec'; }).length,
  'absent principals is the historical shape, unchanged');

/* Supporting nobody collapses the executive pile into your own. */
var soloR = withP([]);
assert.strictEqual(soloR.open.filter(function (l) { return l.owner === 'exec'; }).length, 0,
  'solo: nothing is waiting on an executive, because you are the executive');
assert.strictEqual(soloR.open.length, r.open.length, 'the items themselves do not change');
assert.strictEqual(
  soloR.open.filter(function (l) { return l.owner === 'you'; }).length,
  r.open.filter(function (l) { return l.owner === 'you' || l.owner === 'exec'; }).length,
  'they move into yours rather than disappearing');

/* One principal keeps the split and gains a name. */
var oneR = withP([{ label: 'Dana' }]);
assert.ok(oneR.open.some(function (l) { return l.owner === 'exec'; }), 'one principal keeps the pile');
oneR.open.filter(function (l) { return l.owner === 'exec'; }).forEach(function (l) {
  assert.strictEqual(l.principal.label, 'Dana', 'and every item in it names them');
});

/* Several are routed by who was actually on the conversation, not by guesswork. */
var manyR = withP([
  { label: 'Dana', address: 'marcus.bell@northstar.io' },
  { label: 'Marcus', address: 'hr@northstar.io' }
]);
var deckItem = manyR.open.filter(function (l) { return l.subject.indexOf('board deck') > -1; })[0];
var compItem = manyR.open.filter(function (l) { return l.subject.indexOf('comp plan') > -1; })[0];
assert.strictEqual(deckItem.principal.label, 'Dana', 'routed to whoever was on that thread');
assert.strictEqual(compItem.principal.label, 'Marcus', 'and the other thread to the other one');

/* An item on nobody's conversation still gets attributed rather than vanishing. */
var orphan = detectLoops(F.MESSAGES, F.EVENTS, {
  exec: F.EXEC, today: F.TODAY,
  principals: [{ label: 'Dana', address: 'nobody@nowhere.test' }, { label: 'Marcus', address: 'also@nowhere.test' }]
});
orphan.open.filter(function (l) { return l.owner === 'exec'; }).forEach(function (l) {
  assert.ok(l.principal, 'every executive item names someone, even when nobody matches');
});

/* Only the executive pile carries a principal — a chase is on the counterparty. */
r.open.filter(function (l) { return l.owner !== 'exec'; }).forEach(function (l) {
  assert.strictEqual(l.principal, null, 'non-executive items name no principal');
});

/* ---- relationship weighting ---- */
var inv = find('Halcyon', 'owed_by_us');
assert.strictEqual(inv.rel.tier, 'investor', 'VC domain should resolve to investor tier');
var deckRel = find('board deck', 'owed_by_us');
assert.strictEqual(deckRel.rel.tier, 'exec', 'exact-address match must beat the domain rule');
assert.strictEqual(find('Solstice', 'owed_to_us').rel.tier, 'partner');
assert.strictEqual(find('offsite', 'owed_by_us').rel.tier, 'internal', 'domain fallback for colleagues');
var summitRel = find('RevOps Summit', 'unanswered_ask').rel;
assert.strictEqual(summitRel.tier, 'other');
assert.strictEqual(summitRel.weight, 0, 'an "other" contact is labelled but must not gain rank from it');
assert.ok(summitRel.context, 'context travels with the relationship');

/* weighting must actually move the ranking, not just decorate it */
var plain = detectLoops(F.MESSAGES, F.EVENTS, { exec: F.EXEC, today: F.TODAY });
assert.ok(plain.open.every(function (l) { return l.rel === null; }), 'no contacts map means no tiers');
var meridianPlain = plain.open.filter(function (l) { return l.subject.indexOf('Meridian') > -1 && l.type === 'owed_to_us'; })[0];
assert.ok(mer.risk > meridianPlain.risk, 'key-account weighting should raise risk');

/* ---- meeting briefs ---- */
var B = meetingBriefs(F.MESSAGES, F.EVENTS, r.open, { exec: F.EXEC, today: F.TODAY });
var brief = function (s) { return B.filter(function (b) { return b.title.indexOf(s) > -1; })[0]; };

assert.strictEqual(B.length, 3, 'expected 3 upcoming external meetings, got ' + B.length);
assert.ok(!brief('Cobalt'), 'a meeting in the past is not upcoming');
assert.ok(!brief('Weekly revenue staff'), 'internal-only meetings need no briefing');
assert.ok(B[0].start <= B[1].start && B[1].start <= B[2].start, 'briefs run in time order');

/* the one an assistant would catch: QBR tomorrow, agenda requested days ago, never answered */
var qbr = brief('Vector Freight');
assert.ok(qbr, 'QBR brief missing');
assert.strictEqual(qbr.inDays, 1, 'QBR is tomorrow');
assert.strictEqual(qbr.agenda, false);
assert.strictEqual(qbr.items.length, 1, 'the unanswered agenda request should attach to this meeting');
assert.strictEqual(qbr.items[0].type, 'unanswered_ask');
assert.ok(qbr.items[0].what.indexOf('agenda') > -1);
assert.ok(!qbr.items.some(function (i) { return i.eventId === qbr.id; }),
  'the meeting\'s own no-agenda flag must not double up as an item');
assert.strictEqual(qbr.ready, false);

/* runway: an agenda for tomorrow has to leave today */
assert.strictEqual(qbr.prepBy, '2026-08-06', 'prep for a Friday meeting is due Thursday');
assert.strictEqual(qbr.prepDue, true, 'runway closes today');
assert.strictEqual(qbr.prepLate, false, 'today is still in time');

/* a meeting that genuinely needs nothing */
var nw = brief('Northwind');
assert.ok(nw && nw.ready === true, 'Northwind has an agenda and no open items — should read ready');
assert.strictEqual(nw.items.length, 0);
assert.ok(nw.lastContact, 'last contact date should resolve from the thread');

/* today's call: no agenda, so not ready */
var lark = brief('Larkspur');
assert.ok(lark && lark.inDays === 0 && lark.agenda === false && lark.ready === false);
assert.strictEqual(lark.prepLate, true, 'prep window for a meeting today has already passed');
assert.strictEqual(nw.prepDue, false, 'a prepared meeting five days out needs nothing today');

/* ---- a delivery only closes the promise it refers to ---- */
var msg = function (id, date, body, attach) {
  return { id: id, threadId: 'z', subject: 'Thread', from: F.EXEC, to: ['x@acme.com'],
           date: date, attach: !!attach, body: body };
};
var twoPromises = detectLoops([
  msg('a', '2026-08-03T09:00', "I'll send the pricing sheet by Wednesday."),
  msg('b', '2026-08-04T09:00', "I'll also get you the security questionnaire by Friday."),
  msg('c', '2026-08-05T09:00', 'Pricing attached.', true)
], [], { exec: F.EXEC, today: F.TODAY });
assert.strictEqual(twoPromises.closed.length, 1, 'one delivery must not close both promises');
assert.ok(twoPromises.closed[0].what.indexOf('pricing') > -1, 'it closes the one it names');
assert.strictEqual(twoPromises.open.length, 1);
assert.ok(twoPromises.open[0].what.indexOf('questionnaire') > -1,
  'the undelivered promise must survive — silently dropping it is the worst failure here');

/* a promise that names nothing must still be closable — "I'll send it Thursday EOD"
   has no subject-matter words, so there is nothing to match and nothing to block on */
var vague = detectLoops([
  msg('a', '2026-08-03T09:00', "Yes — I'll send it Thursday EOD."),
  msg('b', '2026-08-05T09:00', 'Revenue section attached — numbers are current.', true)
], [], { exec: F.EXEC, today: F.TODAY });
assert.strictEqual(vague.closed.length, 1, 'a contentless promise must not become uncloseable');

/* a delivery with nothing to discriminate on still closes */
var bare = detectLoops([
  msg('a', '2026-08-03T09:00', "I'll send the pricing sheet by Wednesday."),
  msg('c', '2026-08-05T09:00', 'Attached.', true)
], [], { exec: F.EXEC, today: F.TODAY });
assert.strictEqual(bare.closed.length, 1, 'a bare attachment should still close a lone promise');

/* ...but only while it is the lone promise. "Attached." does not deliver a booked
   venue, and closing something that was never done is the one failure that makes
   this worse than keeping no list at all. Chat makes it the common case rather than
   the corner case, because "done" and "sent" are message types there. */
var ambiguous = detectLoops([
  msg('a', '2026-08-03T09:00', "I'll send the pricing sheet by Wednesday."),
  msg('b', '2026-08-04T09:00', "I'll book the venue for the offsite."),
  msg('c', '2026-08-05T09:00', 'Attached.', true)
], [], { exec: F.EXEC, today: F.TODAY });
assert.strictEqual(ambiguous.closed.length, 0,
  'a delivery naming nothing closes nothing while more than one thing is outstanding');
assert.strictEqual(ambiguous.open.filter(function (l) { return l.type === 'owed_by_us'; }).length, 2);

/* The ordering matters, not just the count. A promise made *after* a delivery was
   not outstanding when it arrived, so the delivery still closes the one that was —
   otherwise an ordinary back-and-forth stops closing anything at all. */
var interleaved = detectLoops([
  msg('a', '2026-08-01T09:00', "I'll send the pricing sheet Monday."),
  msg('b', '2026-08-02T09:00', 'Attached.', true),
  msg('c', '2026-08-03T09:00', "I'll book the venue for the offsite."),
  msg('d', '2026-08-04T09:00', 'Attached.', true)
], [], { exec: F.EXEC, today: F.TODAY });
assert.strictEqual(interleaved.closed.length, 2,
  'promise, deliver, promise, deliver closes both — each was alone when answered');

/* One delivery may still close two things when it names them both. */
var both = detectLoops([
  msg('a', '2026-08-03T09:00', "I'll send the pricing sheet by Wednesday."),
  msg('b', '2026-08-04T09:00', "I'll send the questionnaire too."),
  msg('c', '2026-08-05T09:00', 'Pricing and questionnaire attached.', true)
], [], { exec: F.EXEC, today: F.TODAY });
assert.strictEqual(both.closed.length, 2, 'a delivery that names two promises closes two');

/* ---- a deadline is inherited only from the other side ----
 *
 * A promise with no date of its own takes one from the message it answers — that is
 * how "I'll get back to you before the deadline" becomes dated. But a deadline you
 * inherit is one somebody else set and you agreed to. Your own earlier messages did
 * not set it, and letting a promise borrow a date from another thing you happened to
 * say is how "I'll have the numbers over by the 15th" comes out due tomorrow, because
 * "tomorrow" appeared in an unrelated sentence further up.
 *
 * Harmless in mail, where a thread is one subject. Found on real Slack messages,
 * where the thread is an entire channel. */
var ownDates = detectLoops([
  msg('a', '2026-08-03T09:00', "I'm going to draft the onboarding doc and share it EOD tomorrow."),
  msg('b', '2026-08-03T09:05', "I'll get to the backlog grooming."),
  msg('c', '2026-08-03T09:10', "I'll have the revenue numbers over to finance by the 15th.")
], [], { exec: F.EXEC, today: F.TODAY });
var find2 = function (s) {
  return ownDates.open.filter(function (l) { return l.what.indexOf(s) > -1; })[0];
};
assert.ok(find2('backlog'), 'the undated promise is still detected');
assert.strictEqual(find2('backlog').due, null,
  'but it must not inherit "tomorrow" from a different promise of your own');
assert.strictEqual(find2('onboarding').due, '2026-08-04', 'a date in the sentence itself is read');
assert.strictEqual(find2('revenue numbers').due, '2026-08-15',
  'including a bare ordinal, which used to be borrowed from elsewhere instead');

/* ---- the day moves: arrivals land, resolved things drop ---- */
var { loopKey } = require('./src/loops.js');
var opts = { exec: F.EXEC, today: F.TODAY, contacts: F.RELATIONSHIPS };
var msgs = F.MESSAGES.slice(), prevKeys = new Set(r.open.map(loopKey));
var timeline = F.INTRADAY.map(function (cp) {
  msgs = msgs.concat(cp.messages);
  var res = detectLoops(msgs, F.EVENTS, opts);
  var keys = new Set(res.open.map(loopKey));
  var added = res.open.filter(function (l) { return !prevKeys.has(loopKey(l)); });
  var gone = [].concat.apply([], [Array.from(prevKeys).filter(function (k) { return !keys.has(k); })]);
  prevKeys = keys;
  return { at: cp.at, res: res, added: added, gone: gone };
});

/* a delivery resolves the overdue chase and the nudge chasing it */
assert.strictEqual(timeline[0].added.length, 0, 'a delivery should add nothing');
assert.strictEqual(timeline[0].gone.length, 2, 'the promise and the chase both close');
assert.ok(timeline[0].res.closed.length > r.closed.length, 'it moves into the cleared list');
assert.ok(!timeline[0].res.open.some(function (l) { return l.subject.indexOf('Meridian') > -1; }),
  'nothing Meridian should remain open');

/* a commitment made midday is tracked from the moment it is made */
assert.strictEqual(timeline[1].added.length, 1, 'exactly one new commitment');
var fresh = timeline[1].added[0];
assert.strictEqual(fresh.type, 'owed_by_us');
assert.strictEqual(fresh.owner, 'exec', 'only she can pull the renewal stories together');
assert.strictEqual(fresh.due, '2026-08-10', '"by Monday" resolves to the actual Monday');
assert.strictEqual(fresh.rel.tier, 'exec');

/* a follow-up must not erase the earlier unanswered request */
var qbrAsk = timeline[2].res.open.filter(function (l) {
  return l.type === 'unanswered_ask' && l.subject.indexOf('Vector Freight') > -1;
})[0];
assert.ok(qbrAsk, 'the original agenda request survives a follow-up on the same thread');
assert.strictEqual(qbrAsk.said, '2026-07-31', 'and is still aged from when they first asked');
assert.strictEqual(qbrAsk.pendingCount, 2, 'both unanswered asks are counted');

/* identity is stable across recomputation, so nothing false-flags as new */
var again = detectLoops(F.MESSAGES, F.EVENTS, opts);
assert.deepStrictEqual(again.open.map(loopKey).sort(), r.open.map(loopKey).sort(),
  'the same input must produce the same keys');
assert.strictEqual(new Set(r.open.map(loopKey)).size, r.open.length, 'keys are unique');

/* ranking: overdue and due-today outrank idle chatter */
assert.ok(r.open[0].risk >= r.open[r.open.length - 1].risk);
assert.ok(['overdue', 'due_today'].indexOf(r.open[0].status) > -1, 'top item should be overdue or due today');

/* DELIVER matches the bare word "signed", so a sentence promising a signed
   document used to look like a delivery and was dropped before it could become
   a loop. It commits, though, and a commitment is future tense by construction. */
var signedPromise = [{ id: 's1', threadId: 'ts', subject: 'Order form', from: 'them@acme.com',
  to: ['me@co.com'], date: '2026-08-01T10:00', attach: false,
  body: "We'll have the signed order form back to you Friday Aug 8." }];
var caught = detectLoops(signedPromise, [], { exec: 'me@co.com', today: '2026-08-12' }).open;
assert.strictEqual(caught.length, 1, 'a promise to send a signed document is still a promise');
assert.strictEqual(caught[0].type, 'owed_to_us');
assert.strictEqual(caught[0].due, '2026-08-08', 'and it keeps its deadline');
assert.strictEqual(caught[0].status, 'overdue');

/* ...while with nothing committed, delivery language still reads as delivery. */
signedPromise[0].body = 'Signed order form attached.';
assert.strictEqual(detectLoops(signedPromise, [], { exec: 'me@co.com', today: '2026-08-12' }).open.length, 0,
  'a bare delivery is not a commitment');

/* A delivery closes a promise only if the delivering sentence is about that promise.
   Whole-message matching let one stray delivery word close an unrelated commitment,
   which is the failure that takes a live item off the list without it being done. */
var pricing = [
  { id: 'c1', threadId: 'tc', subject: 'Acme pricing', from: 'them@acme.com', to: ['me@co.com'],
    date: '2026-08-01T10:00', attach: false, body: "We'll send the pricing sheet Friday Aug 8." },
  { id: 'c2', threadId: 'tc', subject: 'Acme pricing', from: 'them@acme.com', to: ['me@co.com'],
    date: '2026-08-04T10:00', attach: false, body: 'The NDA is signed. Still working on the pricing sheet.' }
];
var stillOpen = detectLoops(pricing, [], { exec: 'me@co.com', today: '2026-08-12' });
assert.strictEqual(stillOpen.closed.length, 0, 'a delivery about the NDA does not close the pricing promise');
assert.strictEqual(stillOpen.open.length, 1, 'and the promise is still on the list');

/* ...while a delivery that is about the promise still closes it. */
pricing[1].body = 'Pricing sheet attached.';
assert.strictEqual(detectLoops(pricing, [], { exec: 'me@co.com', today: '2026-08-12' }).closed.length, 1,
  'a real delivery still closes');

console.log('open loops: ' + r.open.length + ' | cleared: ' + r.closed.length + '\n');
['them', 'you', 'exec'].forEach(function (o) {
  var items = r.open.filter(function (l) { return l.owner === o; });
  console.log('== ' + OWNER[o].title.toUpperCase() + ' (' + items.length + ') — ' + OWNER[o].note);
  items.forEach(function (l) {
    console.log('   [' + String(l.risk).padStart(3) + '] ' + LABEL[l.type].padEnd(19) +
      (l.status + '').padEnd(10) + (l.due ? 'due ' + l.due : 'no date').padEnd(15) +
      (l.rel ? l.rel.label : '—'));
    console.log('         ' + l.what);
  });
  console.log('');
});
console.log('\ncleared:');
r.closed.forEach(function (l) { console.log('  ' + l.closedOn + '  ' + l.who + ' — ' + l.what); });
console.log('\nOK');
