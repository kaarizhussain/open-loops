/* The two meeting signals, and the conditions under which they are allowed to speak.
 *
 * no_followup asks "did a recap go out", and its only evidence is an outbound message
 * addressed to somebody who was at the meeting. `to` means different things depending
 * on where the messages came from — a delivery list in mail, a channel roster in chat —
 * and only the first answers the question. Outside guests are not in your workspace, so
 * on chat the test can only ever come back false: every past external meeting fired
 * forever, and fired even when a recap had been posted.
 *
 * The fix is not to guess better. It is to notice there is no evidence and say so. */
var assert = require('assert');
var { detectLoops } = require('../src/loops.js');

var EXEC = 'me@corp.io', A = 'a@alpha.io', B = 'b@beta.io';
var msg = function (to, when) {
  return { id: 'm' + to.join(''), threadId: 't1', subject: 'Recap', from: EXEC, to: to,
           date: when || '2026-09-01T09:00', body: 'Recap of the call.', attach: false };
};
var past = function (id, title, guest) {
  return { id: id, title: title, start: '2026-08-31T14:00', attendees: [EXEC, guest], agenda: true };
};
var run = function (msgs, evs) {
  var r = detectLoops(msgs, evs, { exec: EXEC, today: '2026-09-02' });
  return { items: r.open.map(function (l) { return l.subject; }), dark: r.dark.no_followup };
};

/* --- with a real recipient list, the signal works exactly as it always did --- */
var both = [past('eA', 'Alpha call', A), past('eB', 'Beta call', B)];
var mail = run([msg([A])], both);
assert.deepStrictEqual(mail.items, ['Beta call'],
  'the meeting that got a recap closes; the one that did not still fires');
assert.strictEqual(mail.dark, 0, 'and nothing is reported as unchecked');

/* --- given only a roster, it must go dark rather than invent an absence --- */
/* This is the case that was wrong: a recap WAS posted, and it fired anyway. */
var chat = run([msg(['colleague@corp.io'])], both);
assert.deepStrictEqual(chat.items, [], 'a roster cannot prove a recap was not sent');
assert.strictEqual(chat.dark, 2, 'so both meetings are counted as unchecked, not as clean');

/* What ships today: slack-run defaults members to [], so `to` is empty on every
   message. Nothing here can answer the question, and the digest has to say so. */
assert.deepStrictEqual(run([msg([])], both), { items: [], dark: 2 },
  'an empty recipient list is no evidence either');
assert.deepStrictEqual(run([], both), { items: [], dark: 2 },
  'and neither is an empty corpus');

/* An internal-only meeting is not a meeting with an outsider, dark or otherwise. */
assert.deepStrictEqual(
  run([], [past('eC', 'Standup', 'colleague@corp.io')]), { items: [], dark: 0 },
  'a room full of colleagues never had a recap to send');

/* The gate is corpus-wide on purpose. Per-meeting would silence the case this signal
   was written for: meeting somebody new and never writing to them — where the
   attendee is, by definition, absent from the corpus. Alpha proves it stays alive. */
var newContact = run([msg([A])], both.concat([past('eD', 'Never wrote', 'stranger@gamma.io')]));
assert.ok(newContact.items.indexOf('Never wrote') > -1,
  'somebody you met and never wrote to is the most valuable thing this finds');

/* Missing and malformed fields must not throw — a connector omits `to` entirely. */
assert.doesNotThrow(function () {
  detectLoops([{ id: 'x', threadId: 't', subject: 's', from: EXEC, date: '2026-09-01T09:00',
                 body: 'no recipients key at all', attach: false }], both,
              { exec: EXEC, today: '2026-09-02' });
}, 'an absent `to` is a shape the adapters really produce');

/* --- a standing meeting is not a fresh oversight every week ---
 *
 * Google expands a series into one event per occurrence, each with its own id. loopKey
 * is type|eventId, so a weekly sync with an empty body printed NEW every week and
 * nothing could stop it: rejecting an occurrence clears that occurrence, and muting
 * matches the item's text — identical on every unprepped meeting in the workspace, so
 * it would kill the signal everywhere. Suppression has to happen in the detector. */
var occurrence = function (id, agenda, start) {
  return { id: id, series: '_wk', title: 'Weekly sync', start: start,
           attendees: [EXEC, A], agenda: !!agenda };
};
var meetings = function (evs) {
  var r = detectLoops([], evs, { exec: EXEC, today: '2026-09-02' });
  return { items: r.open.map(function (l) { return l.subject; }), quiet: r.dark.quietSeries };
};

assert.deepStrictEqual(
  meetings([occurrence('i1', false, '2026-08-26T14:00'), occurrence('i2', false, '2026-09-03T14:00')]),
  { items: [], quiet: 1 },
  'a series that has never carried an agenda is how that meeting runs, not an oversight');

/* One occurrence with an agenda arms it — this is a meeting that normally gets one,
   so a blank week is worth flagging. One is enough, not two: a fortnight's fetch holds
   two or three occurrences of a weekly series, so a higher bar would disarm on the
   second missed week, which is precisely the week worth catching. */
assert.deepStrictEqual(
  meetings([occurrence('i1', true, '2026-08-26T14:00'), occurrence('i2', false, '2026-09-03T14:00')]),
  { items: ['Weekly sync'], quiet: 0 },
  'a series that usually gets an agenda is flagged when one is missing');

assert.deepStrictEqual(
  meetings([{ id: 'o1', series: null, title: 'One-off review', start: '2026-09-03T14:00',
              attendees: [EXEC, A], agenda: false }]),
  { items: ['One-off review'], quiet: 0 },
  'a genuine one-off is always worth saying');

/* Events from a source that knows nothing about recurrence must behave as before. */
assert.deepStrictEqual(
  meetings([{ id: 'o2', title: 'No series key at all', start: '2026-09-03T14:00',
              attendees: [EXEC, A], agenda: false }]),
  { items: ['No series key at all'], quiet: 0 },
  'an absent series field is a one-off, not a silenced series');

console.log('meetings: OK');
