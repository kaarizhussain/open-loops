/* Calendar times and "today" are the reader's, however the provider writes them (adversarial review 2026-10-05, Codex finding 7 and the calendar pass's D2/D4).
 *
 *   - calendar.js sliced the first 16 characters of an event's dateTime and ignored its offset, so one meeting written "2026-10-05T21:00:00-04:00" and
 *     "2026-10-06T01:00:00Z" landed on different days with different urgency (due_today, risk 100 vs due_soon, risk 62). A time that carries an offset is now
 *     converted to the run's tzOffset; a time with no offset, an all-day date, and a call that gives no offset are left as they were.
 *   - the digest's date defaulted to the UTC date, so at 21:30 in New York on Monday it was headed Tuesday and "tomorrow" counted from the wrong day.
 *   - a booked conference room is listed as an attendee with resource: true and counted as an external party, so a meeting with only a room in it asked for an agenda.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');
var { parseEvents, startOf } = require('../src/calendar.js');
var { detectLoops } = require('../src/loops.js');

var EXEC = 'me@corp.io', EDT = -240;
var ev = function (start, extra) { return Object.assign({ id: 'e1', summary: 'Review', start: start, end: start, attendees: [{ email: EXEC, self: true }, { email: 'x@other.io' }] }, extra || {}); };
var starts = function (iso, tz) { return parseEvents({ events: [ev({ dateTime: iso })] }, tz === undefined ? undefined : { tzOffset: tz })[0].start; };

/* ------------------------------ one instant, one wall-clock time ------------------------------ */
assert.strictEqual(starts('2026-10-05T21:00:00-04:00', EDT), '2026-10-05T21:00');
assert.strictEqual(starts('2026-10-06T01:00:00Z', EDT), '2026-10-05T21:00', 'the same instant written in UTC is the same wall-clock time');
assert.strictEqual(starts('2026-10-06T01:00:00.000Z', EDT), '2026-10-05T21:00', 'with or without fractional seconds');
assert.strictEqual(starts('2026-10-06T00:30:00+05:30', EDT), '2026-10-05T15:00', 'a half-hour zone');
assert.strictEqual(starts('2026-10-06T09:00:00+13:45', EDT), '2026-10-05T15:15', 'a quarter-hour zone');
assert.strictEqual(starts('2026-10-05T21:00:00-0400', EDT), '2026-10-05T21:00', 'an offset without a colon');
assert.strictEqual(starts('2026-11-02T01:00:00Z', -300), '2026-11-01T20:00', 'and the offset is the run\'s, so it follows the config when the clocks change');
// What is left alone.
assert.strictEqual(starts('2026-10-06T09:00:00', EDT), '2026-10-06T09:00', 'a time with no offset is already wall-clock');
assert.strictEqual(starts('2026-10-06T01:00:00Z'), '2026-10-06T01:00', 'a caller that gives no offset gets the old reading');
assert.strictEqual(startOf({ date: '2026-10-06' }, EDT), '2026-10-06T00:00', 'an all-day event has no time to convert');
assert.strictEqual(startOf({ date: '2026-10-06T00:00:00Z' }, EDT), '2026-10-06T00:00', 'even when the date field carries a time');
assert.strictEqual(startOf(null, EDT), null);

// The review's own comparison: the same meeting, two spellings, the same priority.
var open = function (iso) {
  var evs = parseEvents({ events: [ev({ dateTime: iso })] }, { tzOffset: EDT });
  return detectLoops([], evs, { exec: EXEC, today: '2026-10-05' }).open.map(function (l) { return [l.type, l.status, l.due, l.risk]; });
};
var local = open('2026-10-05T21:00:00-04:00'), utc = open('2026-10-06T01:00:00Z');
assert.ok(local.length === 1 && local[0][1] === 'due_today', 'the 21:00 EDT meeting is due today: ' + JSON.stringify(local));
assert.deepStrictEqual(utc, local, 'and so is the same meeting written in UTC');

/* ------------------------------ through the runner ------------------------------ */
var d = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-tz-'));
var n = 0;
var writeCfg = function (tz) { var p = path.join(d, 'c' + (n++) + '.json'); fs.writeFileSync(p, JSON.stringify({ you: EXEC, tzOffset: tz, spotCheck: 0, lookbackDays: 30, ledger: path.join(d, 'l' + (n++) + '.json') })); return p; };
var digest = function (iso, extra) {
  var input = path.join(d, 'in' + (n++) + '.json');
  fs.writeFileSync(input, JSON.stringify(Object.assign({ today: '2026-10-05', conversations: [{ channel: '#ops', messages: [{ ts: '1790870400.000001', user: 'U0EXAMPLE002', text: 'Hi team' }], complete: true }],
    events: { events: [ev({ dateTime: iso })] }, dm: { messages: [] }, dmLookup: 'searched_none' }, extra || {})));
  return require('../slack-run.js').main([input, '--config', writeCfg(EDT), '--dry']).replace(/ref [0-9a-f]{4}/, 'ref ----');
};
var a = digest('2026-10-05T21:00:00-04:00'), b = digest('2026-10-06T01:00:00Z');
assert.strictEqual(b, a, 'the digest is the same whichever way the provider wrote the time');
assert.ok(/No agenda attached/.test(a), 'and it does say the meeting has no agenda');

/* ------------------------------ the digest is for the reader's day ------------------------------ */
var frozen = function (isoNow, tz) {
  var cfg = writeCfg(tz), input = path.join(d, 'in' + (n++) + '.json');
  fs.writeFileSync(input, JSON.stringify({ conversations: [{ channel: '#ops', messages: [{ ts: '1790870400.000001', user: 'U0EXAMPLE002', text: 'Hi team' }], complete: true }], dm: { messages: [] }, dmLookup: 'searched_none' }));
  var script = "var R=Date,t=new R(" + JSON.stringify(isoNow) + ").getTime();" +
    "global.Date=class extends R{constructor(...a){a.length?super(...a):super(t)} static now(){return t}};" +
    "console.log(require(" + JSON.stringify(path.join(__dirname, '..', 'slack-run.js')) + ").main([" + JSON.stringify(input) + ",'--config'," + JSON.stringify(cfg) + ",'--dry']).split(String.fromCharCode(10))[0]);";
  var r = cp.spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout.trim();
};
// 21:30 EDT on Monday 5 October is 01:30 UTC on Tuesday 6 October.
assert.ok(/^OPEN LOOPS — for 2026-10-05 · Mon /.test(frozen('2026-10-06T01:30:00Z', EDT)), 'at 21:30 New York time the digest is for Monday');
assert.ok(/^OPEN LOOPS — for 2026-10-06 · Tue /.test(frozen('2026-10-06T01:30:00Z', 0)), 'with no offset configured it is still the UTC date');
assert.ok(/^OPEN LOOPS — for 2026-10-05 · Mon /.test(frozen('2026-10-05T17:00:00Z', EDT)), 'and mid-afternoon agrees either way');

/* ------------------------------ a room is not a person ------------------------------ */
var room = { email: 'c_1888@resource.calendar.google.com', resource: true, displayName: 'Room 4' };
var withAttendees = function (attendees) {
  var evs = parseEvents({ events: [ev({ dateTime: '2026-10-06T09:00:00-04:00' }, { attendees: attendees })] }, { tzOffset: EDT });
  return { guests: evs[0].attendees, open: detectLoops([], evs, { exec: EXEC, today: '2026-10-05' }).open.map(function (l) { return l.type; }) };
};
var onlyRoom = withAttendees([{ email: EXEC, self: true }, room]);
assert.ok(onlyRoom.guests.indexOf(room.email) === -1, 'the room is not a guest');
assert.deepStrictEqual(onlyRoom.open, [], 'so a meeting with only a room in it asks for no agenda');
assert.deepStrictEqual(withAttendees([{ email: EXEC, self: true }, room, { email: 'x@other.io' }]).open, ['unprepped_meeting'], 'a real external guest beside the room still does');
assert.deepStrictEqual(withAttendees([{ email: EXEC, self: true }, Object.assign({}, room, { resource: false })]).open, ['unprepped_meeting'], 'an attendee that is not marked as a resource still counts');

fs.rmSync(d, { recursive: true, force: true });
console.log('calendar timezone: OK');
