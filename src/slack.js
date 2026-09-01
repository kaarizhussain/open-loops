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
/* What the connector adds that nobody typed.
 *
 * Every message sent through an app carries a "*Sent using* @App" footer, and that
 * footer is not harmless decoration: it puts the same two or three words in every
 * single message, so every message shares subject matter with every other one and
 * closure matching starts finding agreement everywhere.
 *
 * A thread root carries "Thread: 2 replies (latest: …)" — a count, not an id, and
 * the replies themselves are not in a channel read at all. So it marks that a thread
 * exists and nothing more; fetching it is a separate call. */
var SENT_VIA = /^\s*\*?Sent (?:using|via)\*?\s/i;
var THREAD_NOTE = /^\s*Thread:\s*\d+\s+repl/i;
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
        /* The conversation is the boundary. A channel read gives no thread ids at
         * all — only a note on the root saying how many replies it has — so there is
         * nothing narrower to key on. That is wider than an email thread, and the
         * read window is what keeps closure matching honest inside it. */
        threadId: opts.channel || 'slack',
        // Marks a root whose replies a channel read does not include — fetching them
        // is a separate call the caller has to make.
        hasThread: !!cur.hasThread,
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
              ts: null, hasThread: false, attach: false, body: [] };
      return;
    }
    if (!cur) return;                       // preamble before the first message

    var t = line.match(TS_LINE);
    if (t && !cur.ts) { cur.ts = t[1]; return; }
    if (THREAD_NOTE.test(line)) { cur.hasThread = true; return; }
    if (SENT_VIA.test(line)) return;                 // the app's own footer, not content
    if (ATTACH_LINE.test(line)) { cur.attach = true; return; }

    cur.body.push(line);
  });
  close();

  /* A message with no timestamp cannot be placed in the conversation at all.
   *
   * Ordered on the raw epoch, not the minute-truncated date. The connector returns
   * newest first, and chat puts many messages inside one minute — sorting on the
   * truncated date leaves them scrambled, and a promise that lands after its own
   * delivery can never be closed by it. */
  return out.filter(function (m) { return m.id; })
            .sort(function (a, b) { return parseFloat(a.id) - parseFloat(b.id); });
}

if (typeof module !== 'undefined') {
  module.exports = { parseChannel: parseChannel, cleanText: cleanText, stamp: stamp };
}
