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

/* Two formats, because reading a channel and reading a thread do not agree.
 *
 * A channel read puts the whole identity on one banner:
 *   === Message from Alex Rivera <you@example.com> (U0EXAMPLE001) at … ===
 *
 * A thread read separates the banner from the identity:
 *   === THREAD PARENT MESSAGE ===        or   --- Reply 1 of 3 ---
 *   From: Alex Rivera <you@example.com> (U0EXAMPLE001)
 *   Time: 2026-09-01 16:03:11 EDT
 *
 * Both were copied from live responses. Neither is documented anywhere, which is the
 * standing risk of parsing a presentation format — but a thread read is the only way
 * to see a reply at all, so there is no version of this that reads one shape. */
var HEADER = /^=== Message from (.+?)(?:\s+<([^>]+)>)?\s+\(([UWB][A-Z0-9]+)\)\s+at\s+(.*?)\s*===\s*$/;
var THREAD_START = /^\s*(?:===\s*THREAD PARENT MESSAGE\s*===|-{2,}\s*Reply \d+ of \d+\s*-{2,})\s*$/i;
var THREAD_BANNER = /^\s*===\s*THREAD REPLIES\b/i;
var FROM_LINE = /^From:\s*(.+?)(?:\s+<([^>]+)>)?\s+\(([UWB][A-Z0-9]+)\)\s*$/;
var TIME_LINE = /^Time:\s*\S/i;
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
 * These arrive as ordinary messages and would otherwise be parsed for promises.
 *
 * Anchored at the end, because a notice IS the whole message. Searched anywhere in the
 * body — which is what this did — it also matched a sentence that merely mentions one,
 * and the match discards the message whole: "Sana has joined the channel, so I'll send
 * her the onboarding pack Thursday" is a commitment that was disappearing entirely. */
var SYSTEM = /\b(?:has joined the channel|has left the channel|set the channel (?:purpose|topic)|pinned a message|added an integration)\s*[.!]?$/i;

/* Parse one channel or DM read.
 *
 * opts: { channel, members, self, selfUid, tzOffset }
 *   channel  — display name, becomes `subject`. Slack has no subject line, and the
 *              conversation name is the closest thing to what a thread is "about".
 *   members  — addresses of the other participants, becomes `to`.
 *   self     — the reader's address, so direction resolves the same way mail does.
 *   selfUid  — the reader's Slack id, which is what the banner always carries.
 */
function parseChannel(text, opts) {
  opts = opts || {};
  var lines = String(text || '').split(/\r?\n/);
  var out = [], cur = null;

  /* The email on a banner is optional — Slack only returns one when the token holds
   * users:read.email and the account has an address set, so guests, app messages and
   * any workspace that withheld the scope arrive without it. For everyone else that
   * only costs a readable name. For the reader it inverts the entire digest: their own
   * uid never equals the address they configured, so every promise they made reads as
   * a promise somebody made to them, and the list tells them to chase themselves.
   *
   * Guarded on the id actually looking like one, because `selfDm` is documented as a
   * channel to post to and only happens to be a user id. A DM id would match nobody. */
  var selfUid = /^[UW][A-Z0-9]+$/.test(opts.selfUid || '') ? opts.selfUid : null;
  var selfAddr = String(opts.self || '').toLowerCase();

  var close = function () {
    if (!cur) return;
    /* A file dropped in with no comment is a message with nothing left once the
     * attachment line is consumed, and an empty body is discarded below — so the
     * commonest way a promise is actually kept produced no record of being kept, and
     * the item nagged forever. Falling back to the attachment line gives the closure
     * check something to match a filename against.
     *
     * The marker this relies on was never observed on a live workspace (see the note
     * at the top of test_slack.js), so if the real format differs this changes
     * nothing rather than guessing at a new one. */
    var body = cleanText(cur.body.join('\n')) || cleanText(cur.files || '');
    // Drop empties and Slack's own housekeeping notices.
    if (body && !SYSTEM.test(body)) {
      out.push({
        id: cur.ts,
        /* A channel read gives no thread ids, only a note on the root saying how many
         * replies it has, so a plain channel is one wide boundary and the read window
         * is what keeps closure matching honest inside it. A thread read is different:
         * the caller passes the root's timestamp, and that is a real boundary — the
         * narrowest Slack offers, and the one thing here that matches email's. */
        threadId: opts.threadId || opts.channel || 'slack',
        // Marks a root whose replies a channel read does not include — fetching them
        // is a separate call the caller has to make.
        hasThread: !!cur.hasThread,
        subject: opts.channel || 'Slack',
        from: cur.email || (selfUid && cur.uid === selfUid && selfAddr) ||
              (cur.uid + '@slack.local'),
        to: (opts.members || []).slice(),
        date: stamp(cur.ts, opts.tzOffset),
        body: body,
        attach: !!cur.attach
      });
    }
    cur = null;
  };

  var start = function (name, email, uid) {
    close();
    cur = { name: name || '', email: (email || '').toLowerCase(), uid: uid || '',
            ts: null, hasThread: false, attach: false, files: '', body: [] };
  };

  lines.forEach(function (line) {
    var h = line.match(HEADER);
    if (h) { start(h[1], h[2], h[3]); return; }      // channel read: identity inline
    if (THREAD_START.test(line)) { start(); return; } // thread read: identity follows
    if (THREAD_BANNER.test(line)) { close(); return; } // a section heading, not a message
    if (!cur) return;                                 // preamble before the first message

    // Only fills an identity the banner did not carry, so a body line that happens
    // to begin "From:" cannot rewrite who sent the message.
    var f = !cur.uid && line.match(FROM_LINE);
    if (f) { cur.name = f[1]; cur.email = (f[2] || '').toLowerCase(); cur.uid = f[3]; return; }
    if (TIME_LINE.test(line)) return;                 // the localised date, unparsed

    var t = line.match(TS_LINE);
    if (t && !cur.ts) { cur.ts = t[1]; return; }
    if (THREAD_NOTE.test(line)) { cur.hasThread = true; return; }
    if (SENT_VIA.test(line)) return;                  // the app's own footer, not content
    if (ATTACH_LINE.test(line)) { cur.attach = true; cur.files = line; return; }

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
