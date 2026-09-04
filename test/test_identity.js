/* Who counts as an outsider.
 *
 * `domain()` was doing two jobs — reading an address's host, and standing in for "same
 * organisation" — and only the first one is always true. On a consumer host the second
 * reading claims every Gmail user on earth is your colleague, and three things followed
 * from that, in ascending order of harm:
 *
 *   - unprepped_meeting never fired, silently
 *   - no_followup never fired, silently
 *   - a calendar hold could no longer close a promise to book one, because the person
 *     on the invite read as internal and their presence "proved nothing"
 *
 * The third is the one that matters. The other two are absences nobody notices; that
 * one puts an item on the list every morning that the reader has already done and
 * cannot get rid of, which is the exact failure this tool exists to prevent. */
var assert = require('assert');
var { detectLoops, side } = require('../src/loops.js');

/* --- the primitive --- */
assert.strictEqual(side('dana@northstar.io'), 'northstar.io',
  'a real company domain is the side, exactly as domain() used to return');
assert.strictEqual(side('me@gmail.com'), 'me@gmail.com',
  'a shared host is nobody\'s employer, so the address is its own side');
assert.strictEqual(side('me+invoices@gmail.com'), 'me@gmail.com', 'a plus-tag is the same person');
assert.strictEqual(side('U0ABC@slack.local'), 'u0abc@slack.local',
  'two people the connector gave no address to are not colleagues');
assert.strictEqual(side('Dana@NorthStar.IO'), 'northstar.io', 'case is not identity');
assert.strictEqual(side('nonsense'), 'nonsense', 'an unparseable address must not throw');
assert.strictEqual(side(null), '', 'nor a missing one');

/* The reason this is a table and not a pattern. A regex over these provider names also
   swallows real companies, and their staff would have every colleague reclassified as
   an outsider — every internal meeting firing as unprepped, daily. */
['outlook.ai', 'aol.xyz', 'msn.dev', 'live.io', 'icloud.dev', 'gmail.consulting']
  .forEach(function (host) {
    assert.strictEqual(side('someone@' + host), host, host + ' is somebody\'s employer');
  });

/* --- what it fixes, end to end --- */
var msg = function (o) {
  return { id: o.id, threadId: 't1', subject: o.subject || 'Rollout plan', from: o.from,
           to: o.to || [], date: o.date, body: o.body, attach: false };
};
var evt = function (o) {
  return { id: o.id, title: o.title, start: o.start, attendees: o.attendees, agenda: !!o.agenda };
};
var types = function (r) { return r.open.map(function (l) { return l.type; }); };

/* A meeting with someone outside, no agenda, the day after tomorrow. */
function unprepped(exec, other) {
  return types(detectLoops([], [evt({ id: 'e1', title: 'Vendor kickoff',
    start: '2026-09-03T14:00', attendees: [exec, other] })],
    { exec: exec, today: '2026-09-02' }));
}
assert.deepStrictEqual(unprepped('me@corp.io', 'client@other.io'), ['unprepped_meeting'],
  'the corporate path is unchanged');
assert.deepStrictEqual(unprepped('me@gmail.com', 'client@gmail.com'), ['unprepped_meeting'],
  'and now fires for someone running this on a personal address');
assert.deepStrictEqual(unprepped('me@corp.io', 'colleague@corp.io'), [],
  'a room full of colleagues is still not an external meeting');

/* The one that was costing something. A promise to get a call in the diary is kept by
   the call being in the diary — proved by the counterparty being on the invite. The
   event title below shares no words with the promise on purpose, so the only thing
   that can close it is that identity test. */
function booking(exec, other, booked) {
  var r = detectLoops(
    [msg({ id: 'm1', from: exec, to: [other], date: '2026-08-28T10:00',
           body: "Let's schedule a sync for Thursday to walk through the rollout plan." })],
    booked ? [evt({ id: 'ev1', title: 'Catch up', start: '2026-09-03T14:00',
                    attendees: [exec, other], agenda: true })] : [],
    { exec: exec, today: '2026-09-02' });
  return { open: types(r), closed: r.closed.map(function (l) { return l.closedBy; }) };
}

['me@corp.io|client@other.io', 'me@gmail.com|client@gmail.com'].forEach(function (pair) {
  var p = pair.split('|'), who = p[0], them = p[1];
  assert.deepStrictEqual(booking(who, them, false).open, ['agreed_unscheduled'],
    'unbooked, it stays open: ' + who);
  var done = booking(who, them, true);
  assert.deepStrictEqual(done.open, [], 'once booked it must leave the list: ' + who);
  assert.deepStrictEqual(done.closed, ['In the diary: Catch up'],
    'and say the diary closed it, not that it vanished: ' + who);
});

/* --- a curly apostrophe is still an apostrophe ---
 *
 * macOS and iOS substitute ' for ' system-wide, and anything pasted out of Word or Docs
 * carries it. Matching only the straight one made every contraction invisible — and a
 * missed commitment produces nothing to reject, so the correction loop can never surface
 * it. The Enron corpus cannot catch this either: 0 of 8,716 messages contain one, because
 * 2001 mail was plain text. */
var CURLY = '’';
[
  ["I'll send the deck Thursday.", 'owed_by_us'],
  ["We'll have the signed copy back Friday.", 'owed_by_us'],
  ["Let's schedule a sync for Thursday to walk through the plan.", 'agreed_unscheduled'],
  ["I'm going to draft the onboarding doc and share it tomorrow.", 'owed_by_us']
].forEach(function (c) {
  var straight = c[0], curly = c[0].replace(/'/g, CURLY);
  var run = function (body) {
    return detectLoops([{ id: 'm1', threadId: 't1', subject: 'Rollout', from: 'me@corp.io',
                          to: ['them@other.io'], date: '2026-08-28T10:00', body: body, attach: false }],
                       [], { exec: 'me@corp.io', today: '2026-09-02' })
      .open.map(function (l) { return l.type; });
  };
  assert.deepStrictEqual(run(straight), [c[1]], 'straight apostrophe: ' + straight);
  assert.deepStrictEqual(run(curly), [c[1]],
    'and the curly one must find the same thing: ' + curly);
});

/* --- shapes a real adapter produces that used to throw ---
 *
 * Two lines read `.to[0]` with no guard — one on every promise, one on every unanswered
 * question of your own. An adapter that omits `to` on an outbound message, which is
 * exactly what a single-member Slack workspace does, took the whole run down. On the
 * unattended evening job that means no digest and no explanation. */
assert.doesNotThrow(function () {
  detectLoops([{ id: 'm1', threadId: 't1', subject: '#deals', from: 'me@corp.io',
                 date: '2026-09-01T10:00', body: "I'll send the deck Thursday.", attach: false }],
              [], { exec: 'me@corp.io', today: '2026-09-02' });
}, 'a promise in a message with no `to` key');

assert.doesNotThrow(function () {
  detectLoops([{ id: 'm1', threadId: 't1', subject: '#deals', from: 'me@corp.io',
                 date: '2026-08-25T10:00', attach: false,
                 body: 'Let me know your thoughts on the deck when you get a chance.' }],
              [], { exec: 'me@corp.io', today: '2026-09-02' });
}, 'and an unanswered question of your own in one');

/* --- the diary closes a promise whatever case the address arrived in ---
 *
 * calendar.js lowercases every attendee; an address taken off a Slack profile need not
 * be. The comparison was exact, so a MixedCase counterparty missed, the hold could not
 * close the promise to book it, and the item nagged forever. Same failure as comparing
 * domains for identity — one layer further down. */
function bookedWith(counterpartyAs) {
  var r = detectLoops(
    [msg({ id: 'm1', from: 'me@corp.io', to: [counterpartyAs], date: '2026-08-28T10:00',
           body: "Let's schedule a sync for Thursday to walk through the rollout plan." }),
     msg({ id: 'm2', from: counterpartyAs, to: ['me@corp.io'], date: '2026-08-28T11:00',
           body: 'Sounds good.' })],
    [evt({ id: 'ev1', title: 'Catch up', start: '2026-09-03T14:00',
           attendees: ['me@corp.io', 'sana@halcyon.io'], agenda: true })],
    { exec: 'me@corp.io', today: '2026-09-02' });
  return r.closed.map(function (l) { return l.closedBy; });
}
assert.deepStrictEqual(bookedWith('sana@halcyon.io'), ['In the diary: Catch up']);
assert.deepStrictEqual(bookedWith('Sana@Halcyon.io'), ['In the diary: Catch up'],
  'the diary closes it however the address was capitalised');

console.log('identity: OK');
