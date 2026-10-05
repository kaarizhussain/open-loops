/* Google Calendar → the shape loops.js expects.
 *
 * Two of the seven signals live entirely in the gap between what was said and what is
 * on the calendar — a call agreed to that never got booked, a meeting with external
 * attendees and no agenda. Neither can fire without this, and they are the two a
 * single-product assistant is least able to reproduce, because they are not in the
 * messages at all.
 *
 * Copied from a live response rather than from the API docs. Three things the docs
 * would not have made obvious:
 *
 *   - fields are ABSENT rather than empty. No attendees means no `attendees` key, and
 *     no description means no `description` key. Reading `e.attendees.length` throws.
 *   - an all-day event carries `start.date`; a timed one carries `start.dateTime`.
 *     The README claimed dateTime, which is true of half of them.
 *   - cancelled events still come back, with status "cancelled".
 */

/* 'YYYY-MM-DDTHH:MM', in whatever local time the event was expressed in.
 *
 * A dateTime carries its own offset ("2026-09-03T14:00:00-04:00"), and the first
 * sixteen characters are already the local wall-clock time — which is what a deadline
 * is judged against. An all-day event has no time, so it starts when the day does. */
function startOf(when, tzOffset) {
  if (!when) return null;
  var raw = when.dateTime || when.date;
  if (!raw) return null;
  if (!when.dateTime) return String(raw).slice(0, 10) + 'T00:00';
  /* The same instant is written differently depending on where the provider anchors it: "2026-10-05T21:00:00-04:00" and "2026-10-06T01:00:00Z" are one meeting, and
   * slicing the text put them on different days (a different priority, a day apart; adversarial review 2026-10-05). When the run's offset is known, a time that
   * carries its own offset is converted to the reader's wall clock, so the day and hour are the reader's whichever way it was written. A time with no offset is
   * already wall-clock and is left as it is; an all-day date has no time to convert. */
  if (typeof tzOffset === 'number' && isFinite(tzOffset) && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(String(raw).trim())) {
    var ms = Date.parse(String(raw).trim());
    if (!isNaN(ms)) return new Date(ms + tzOffset * 60000).toISOString().slice(0, 16);
  }
  return String(raw).slice(0, 16);
}

/* Everyone on it, as addresses.
 *
 * The organiser is included because Google leaves them out of `attendees` on events
 * nobody was invited to — and a meeting whose only external party is the person who
 * called it is still a meeting with an external party. */
function guests(e) {
  var seen = {}, out = [];
  var add = function (addr) {
    var a = String(addr || '').toLowerCase();
    if (!a || seen[a]) return;
    seen[a] = 1;
    out.push(a);
  };
  (e.attendees || []).forEach(function (a) {
    // A declined attendee is not attending, and should not make a meeting external. Nor is a room: Google lists a booked conference room as an attendee
    // with resource: true, and a meeting whose only "external party" is a room has no one to send an agenda to.
    if (a.responseStatus !== 'declined' && !a.resource) add(a.email);
  });
  if (e.organizer) add(e.organizer.email);
  return out;
}

/* Parse one list_events response.
 *
 * Takes the object or the raw JSON string. `events` is itself absent when the window
 * is empty, which is the same absent-not-empty habit as everything else here. */
function parseEvents(response, opts) {
  var tz = opts && typeof opts.tzOffset === 'number' ? opts.tzOffset : undefined;
  var data = typeof response === 'string' ? JSON.parse(response || '{}') : (response || {});
  /* An error envelope is not an empty calendar. `events` is absent when the window is empty,
   * so absence proves nothing — but an error marker, or events that are not a list, is a
   * failed read, and treating it as empty let prior meeting items be marked cleared. */
  if (data && (data.error || data.ok === false)) {
    throw new Error('The calendar responded with an error: ' + String(data.error || data.message || 'ok:false').slice(0, 80));
  }
  if (data && data.events != null && !Array.isArray(data.events)) {
    throw new Error('The calendar response had events that were not a list');
  }
  return (data.events || []).filter(function (e) {
    /* A cancelled meeting cannot be unprepped, and a declined one is not yours to
     * prepare for. Both still come back from the API.
     *
     * Only the first was actually filtered. This comment named both for as long as it
     * has existed, and "send an agenda" kept firing for meetings the reader had turned
     * down — the false positive they can dismiss fastest, and so the one that most
     * quickly teaches them the list is careless. Google marks the reader's own attendee
     * entry `self: true`. */
    var mine = (e.attendees || []).filter(function (a) { return a.self; })[0];
    // A start that is not a date cannot be placed, and one malformed event used to throw
    // inside the detector and take every other signal down with it.
    return e.status !== 'cancelled' && !(mine && mine.responseStatus === 'declined') &&
      /^\d{4}-\d{2}-\d{2}/.test(startOf(e.start, tz) || '');
  }).map(function (e) {
    return {
      id: e.id,
      title: e.summary || '(no title)',
      start: startOf(e.start, tz),
      attendees: guests(e),
      /* Google expands a recurring series into one event per occurrence, each with its
       * own id and all of them carrying the series id. Without this the detector cannot
       * tell "the weekly sync, again" from "a meeting it has never seen", so a standing
       * meeting with nothing in its body announced itself as new every week and no
       * rejection could ever silence more than the single instance rejected. */
      series: e.recurringEventId || null,
      /* An agenda is a description with something in it. Google omits the key
       * entirely rather than sending an empty string, so this cannot test length
       * without checking the key exists first. */
      agenda: String(e.description || '').trim().length > 0
    };
  }).sort(function (a, b) { return a.start < b.start ? -1 : 1; });
}

if (typeof module !== 'undefined') {
  module.exports = { parseEvents: parseEvents, startOf: startOf, guests: guests };
}
