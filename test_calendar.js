/* The calendar adapter, against the shape a live response actually has.
 *
 * The events below are copied from a real list_events call, trimmed. The habits they
 * exercise — absent keys rather than empty ones, `date` versus `dateTime`, cancelled
 * events still arriving — are all things a hand-written fixture would have got wrong,
 * because they are what you assume rather than what you check. */
var assert = require('assert');
var { parseEvents, startOf, guests } = require('./src/calendar.js');

/* --- verbatim from the connector, minus the fields nothing reads --- */
var live = {
  accessRole: 'owner',
  summary: 'you@example.com',
  timeZone: 'America/New_York',
  events: [{
    created: '2024-01-08T23:49:04Z',
    creator: { email: 'you@example.com', self: true },
    organizer: { email: 'you@example.com', self: true },
    end: { date: '2026-01-18T00:00:00Z' },
    start: { date: '2026-01-17T00:00:00Z' },
    eventType: 'DEFAULT',
    id: '_74q3ch9p_20260117',
    recurringEventId: '_74q3ch9p',
    status: 'confirmed',
    summary: 'Pay gym membership '
  }]
};

var one = parseEvents(live);
assert.strictEqual(one.length, 1);
assert.strictEqual(one[0].title, 'Pay gym membership ');
assert.strictEqual(one[0].start, '2026-01-17T00:00', 'an all-day event starts when the day does');
assert.deepStrictEqual(one[0].attendees, ['you@example.com'],
  'no attendees key at all, so the organiser is who is on it');
assert.strictEqual(one[0].agenda, false, 'and no description key either');

/* An empty window omits `events` entirely rather than sending []. */
assert.deepStrictEqual(parseEvents({ accessRole: 'owner', timeZone: 'UTC' }), []);
assert.deepStrictEqual(parseEvents('{}'), [], 'and it takes the raw string too');
assert.deepStrictEqual(parseEvents(null), []);

/* --- dateTime, which is the other half of them --- */
var timed = parseEvents({ events: [{
  id: 'e1', status: 'confirmed', summary: 'Vector Freight — Q3 QBR',
  start: { dateTime: '2026-09-03T14:00:00-04:00' },
  description: 'Agenda:\n1. Renewal\n2. Roadmap',
  organizer: { email: 'you@example.com' },
  attendees: [{ email: 'YOU@example.com' }, { email: 'lena@vectorfreight.com' }]
}] });
assert.strictEqual(timed[0].start, '2026-09-03T14:00',
  'the wall-clock time is what a deadline is judged against, offset and all');
assert.strictEqual(timed[0].agenda, true, 'a description with something in it is an agenda');
assert.deepStrictEqual(timed[0].attendees, ['you@example.com', 'lena@vectorfreight.com'],
  'addresses are lowered and the organiser is not duplicated');

/* --- what must not come through --- */
var noisy = parseEvents({ events: [
  { id: 'a', status: 'cancelled', summary: 'Called off', start: { dateTime: '2026-09-03T10:00:00Z' } },
  { id: 'b', status: 'confirmed', summary: 'No start at all' },
  { id: 'c', status: 'confirmed', summary: 'Real', start: { dateTime: '2026-09-04T10:00:00Z' } }
] });
assert.deepStrictEqual(noisy.map(function (e) { return e.id; }), ['c'],
  'a cancelled meeting cannot be unprepped, and one with no start cannot be placed');

/* Somebody who declined is not attending, and must not make a meeting external —
   otherwise every invitation you turned down still asks you to prepare for it. */
var declined = parseEvents({ events: [{
  id: 'd', status: 'confirmed', summary: 'Internal sync',
  start: { dateTime: '2026-09-05T10:00:00Z' },
  organizer: { email: 'you@example.com' },
  attendees: [{ email: 'you@example.com' }, { email: 'outsider@other.com', responseStatus: 'declined' }]
}] });
assert.deepStrictEqual(declined[0].attendees, ['you@example.com']);

assert.strictEqual(startOf({}), null, 'neither date nor dateTime is not a start');
assert.deepStrictEqual(guests({}), [], 'an event with nobody on it has nobody on it');

/* --- the point of all this: the two dark signals light up --- */
var { detectLoops } = require('./src/loops.js');
var events = parseEvents({ events: [{
  id: 'qbr', status: 'confirmed', summary: 'Vector Freight — Q3 QBR',
  start: { dateTime: '2026-09-03T14:00:00-04:00' },
  organizer: { email: 'you@example.com' },
  attendees: [{ email: 'you@example.com' }, { email: 'lena@vectorfreight.com' }]
}] });

var msg = {
  id: 'm1', threadId: 't1', subject: 'Vector Freight — Q3 QBR', from: 'you@example.com',
  to: ['lena@vectorfreight.com'], date: '2026-09-01T10:00', attach: false,
  body: "Let's schedule a sync to walk through the renewal."
};
var r = detectLoops([msg], events, { exec: 'you@example.com', today: '2026-09-02' });

var unprepped = r.open.filter(function (l) { return l.type === 'unprepped_meeting'; })[0];
assert.ok(unprepped, 'a meeting tomorrow with an outside guest and no agenda');
assert.strictEqual(unprepped.subject, 'Vector Freight — Q3 QBR');
assert.strictEqual(unprepped.due, '2026-09-03T14:00'.slice(0, 10));

/* And the other one: the same conversation, once the hold exists, is no longer
   "agreed but not booked" — which is the whole reason a calendar is needed to
   suppress it rather than only to raise things. */
var withHold = r.open.filter(function (l) { return l.type === 'agreed_unscheduled'; })[0];
assert.ok(!withHold, 'a matching hold on the calendar settles the agreement');

var without = detectLoops([msg], [], { exec: 'you@example.com', today: '2026-09-02' });
assert.ok(without.open.some(function (l) { return l.type === 'agreed_unscheduled'; }),
  'with no calendar at all it fires, and can never be suppressed — which is why the'
  + ' Slack-only path over-reports it');

console.log('calendar: OK');
