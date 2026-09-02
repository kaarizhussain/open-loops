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
function startOf(when) {
  if (!when) return null;
  var raw = when.dateTime || when.date;
  if (!raw) return null;
  return when.dateTime ? String(raw).slice(0, 16) : String(raw).slice(0, 10) + 'T00:00';
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
    // A declined attendee is not attending, and should not make a meeting external.
    if (a.responseStatus !== 'declined') add(a.email);
  });
  if (e.organizer) add(e.organizer.email);
  return out;
}

/* Parse one list_events response.
 *
 * Takes the object or the raw JSON string. `events` is itself absent when the window
 * is empty, which is the same absent-not-empty habit as everything else here. */
function parseEvents(response) {
  var data = typeof response === 'string' ? JSON.parse(response || '{}') : (response || {});
  return (data.events || []).filter(function (e) {
    /* A cancelled meeting cannot be unprepped, and a declined one is not yours to
     * prepare for. Both still come back from the API. */
    return e.status !== 'cancelled' && startOf(e.start);
  }).map(function (e) {
    return {
      id: e.id,
      title: e.summary || '(no title)',
      start: startOf(e.start),
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
