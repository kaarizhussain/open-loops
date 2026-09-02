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

console.log('meetings: OK');
