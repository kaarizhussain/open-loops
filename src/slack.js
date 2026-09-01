/* Slack → the shape loops.js expects.
 *
 * The mail connector hands back structured JSON. This one hands back a block of
 * display text written to be read by a model, so this is a parser rather than a
 * field mapping — and that is a real fragility: the format is a presentation
 * choice, not an interface, and it can change without warning. Everything here
 * keys off the one line that is unambiguous.
 *
 *   === Message from Alex Rivera <you@example.com> (U0EXAMPLE001) at 2026-09-01 11:06:12 EDT ===
 *   Message TS: 1788275172.381139
 *   the actual text
 *
 * The human date carries a timezone abbreviation and is not worth parsing. The
 * epoch in `Message TS` is exact, so that is what the timestamp comes from.
 */

/* One message header. Name is greedy-safe because the bracketed parts anchor it. */
var HEADER = /^=== Message from (.+?)(?:\s+<([^>]+)>)?\s+\(([UWB][A-Z0-9]+)\)\s+at\s+(.*?)\s*===\s*$/;
var TS_LINE = /^Message TS:\s*([\d.]+)\s*$/;
/* Not yet observed in the wild — the test workspace had no threads. Matched
 * loosely so that a thread marker under any of these spellings is picked up,
 * and its absence simply means "not a reply". */
var THREAD_LINE = /^(?:Thread TS|Thread|In thread|Reply to|Parent)\s*:?\s*([\d.]+)\s*$/i;
var ATTACH_LINE = /^(?:Files?|Attachments?)\s*:/i;

/* Slack writes links, mentions and channel refs as angle-bracket spans. Left in
 * place they become noise the detector has to read around — "<@U0EXAMPLE001>"
 * contributes nothing and a raw URL contributes false topic words. */
function cleanText(s) {
  return String(s || '')
    .replace(/<@[UW][A-Z0-9]+\|([^>]+)>/g, '@$1')      // <@U123|Name> → @Name
    .replace(/<@[UW][A-Z0-9]+>/g, '')                  // <@U123> with no name → drop
    .replace(/<#C[A-Z0-9]+\|([^>]+)>/g, '#$1')         // <#C123|general> → #general
    .replace(/<(?:https?|mailto):[^|>]+\|([^>]+)>/g, '$1')  // labelled link → its label
    .replace(/<((?:https?|mailto):[^>]+)>/g, '$1')     // bare link → the url
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* Slack's ts is epoch seconds with a fractional part. loops.js wants a local-ish
 * 'YYYY-MM-DDTHH:MM' — deadline language resolves relative to the send date, so
 * being an hour out only matters within an hour of midnight. */
function stamp(ts, offsetMinutes) {
  var d = new Date(Math.floor(parseFloat(ts) * 1000) + (offsetMinutes || 0) * 60000);
  return d.toISOString().slice(0, 16);
}

/* A join notice is not a commitment, and neither is a channel-purpose change.
 * These arrive as ordinary messages and would otherwise be parsed for promises. */
var SYSTEM = /\b(has joined the channel|has left the channel|set the channel (?:purpose|topic)|pinned a message|added an integration)\b/i;

/* Parse one channel or DM read.
 *
 * opts: { channel, members, self, tzOffset }
 *   channel  — display name, becomes `subject`. Slack has no subject line, and the
 *              conversation name is the closest thing to what a thread is "about".
 *   members  — addresses of the other participants, becomes `to`.
 *   self     — the reader's address, so direction resolves the same way mail does.
 */
function parseChannel(text, opts) {
  opts = opts || {};
  var lines = String(text || '').split(/\r?\n/);
  var out = [], cur = null;

  var close = function () {
    if (!cur) return;
    var body = cleanText(cur.body.join('\n'));
    // Drop empties and Slack's own housekeeping notices.
    if (body && !SYSTEM.test(body)) {
      out.push({
        id: cur.ts,
        // No thread marker means the conversation itself is the boundary. That is
        // wider than an email thread, which is why closure matching needs the
        // lookback window to keep it honest.
        threadId: cur.threadTs || opts.channel || 'slack',
        subject: opts.channel || 'Slack',
        from: cur.email || (cur.uid + '@slack.local'),
        to: (opts.members || []).slice(),
        date: stamp(cur.ts, opts.tzOffset),
        body: body,
        attach: !!cur.attach
      });
    }
    cur = null;
  };

  lines.forEach(function (line) {
    var h = line.match(HEADER);
    if (h) {
      close();
      cur = { name: h[1], email: (h[2] || '').toLowerCase(), uid: h[3],
              ts: null, threadTs: null, attach: false, body: [] };
      return;
    }
    if (!cur) return;                       // preamble before the first message

    var t = line.match(TS_LINE);
    if (t && !cur.ts) { cur.ts = t[1]; return; }
    var th = line.match(THREAD_LINE);
    if (th) { cur.threadTs = th[1]; return; }
    if (ATTACH_LINE.test(line)) { cur.attach = true; return; }

    cur.body.push(line);
  });
  close();

  // A message with no timestamp cannot be placed in the conversation at all.
  return out.filter(function (m) { return m.id; })
            .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
}

if (typeof module !== 'undefined') {
  module.exports = { parseChannel: parseChannel, cleanText: cleanText, stamp: stamp };
}
