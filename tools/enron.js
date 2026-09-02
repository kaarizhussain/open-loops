/* The Enron corpus -> the shape loops.js takes.
 *
 * Not a shipped adapter. This exists so the detector can be pointed at real
 * correspondence — half a million emails between real people, written without any idea
 * a tool would one day read them — instead of at sentences we made up. Everything the
 * accuracy numbers have measured so far was written by whoever was also writing the
 * regexes, which is the least informative test there is.
 *
 * Get the corpus (443MB, and it is somebody else's mail — do not commit it):
 *   curl -O https://www.cs.cmu.edu/~enron/enron_mail_20150507.tar.gz
 *   tar -xf enron_mail_20150507.tar.gz
 *
 * Three things about the format that a hand-written fixture would have got wrong, all
 * found by reading the files rather than the documentation:
 *
 *   - Replies are quoted INLINE, under "-----Original Message-----". Left in, every
 *     promise the other person ever made is re-detected as yours, on every reply in
 *     the thread. Same class of mistake as the "*Sent using*" footer in Slack.
 *   - `To:` is not clean. Real headers here include a stray leading apostrophe and
 *     addresses split across continuation lines.
 *   - The corpus is text-only: attachments were stripped when it was released. So
 *     `attach` is always false, and any closure rule that leans on an attachment
 *     cannot fire. That is a limit of the corpus, not of the detector — worth
 *     remembering before reading anything into the delivery numbers.
 */
var fs = require('fs');
var path = require('path');

var MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
               Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };

/* "Fri, 8 Mar 2002 08:58:39 -0800 (PST)" -> "2002-03-08T08:58". Local wall clock, the
   way every other adapter here reports it — a deadline is judged against the time the
   sender saw on their own screen. */
function when(raw) {
  var m = String(raw || '').match(/(\d{1,2})\s+([A-Z][a-z]{2})\s+(\d{4})\s+(\d{2}):(\d{2})/);
  if (!m || !MONTHS[m[2]]) return null;
  return m[3] + '-' + MONTHS[m[2]] + '-' + ('0' + m[1]).slice(-2) + 'T' + m[4] + ':' + m[5];
}

function addresses(raw) {
  return String(raw || '')
    .split(',')
    .map(function (a) { return a.replace(/['"<>]/g, '').trim().toLowerCase(); })
    .filter(function (a) { return a.indexOf('@') > 0; });
}

/* Quoted-printable, which about a third of these are.
 *
 * Undecoded, "=" at end of line is a soft break that never gets joined, so a sentence
 * splitter sees fragments and the detector reports half-sentences starting mid-clause.
 * "=20" and friends stay as literal noise inside the text it is matching against. Found
 * by reading the benchmark's own sample output, where two of eight items ended in a
 * bare "=" — which is what a corpus is for. */
function decodeQP(body) {
  return body
    .replace(/=\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, function (_, hex) {
      var c = parseInt(hex, 16);
      // Leave anything non-printable alone rather than injecting control characters.
      return c >= 32 || c === 9 ? String.fromCharCode(c) : ' ';
    });
}

/* Everything below any of these is somebody else's words. */
var QUOTED = [
  /^-{2,}\s*Original Message\s*-{2,}/im,
  /^_{10,}/m,
  /^From:\s.+\nSent:\s/im,
  /^On .{0,80}\bwrote:\s*$/im
];

function unquote(body) {
  var cut = body.length;
  QUOTED.forEach(function (re) {
    var m = body.match(re);
    if (m && m.index < cut) cut = m.index;
  });
  var kept = body.slice(0, cut);
  // Leading ">" quoting has no marker line, so drop those lines wherever they appear.
  return kept.split('\n').filter(function (l) { return !/^\s*>/.test(l); }).join('\n').trim();
}

/* "RE: RE: Whats up!!!!!" and "Fwd: Whats up!!!!!" are one conversation. */
function threadOf(subject) {
  return String(subject || '(none)')
    .replace(/^(\s*(re|fw|fwd)\s*:\s*)+/i, '')
    .trim().toLowerCase() || '(none)';
}

function parse(file) {
  var raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
  /* The corpus is CRLF. Left alone, the carriage returns survive header unfolding and
     end up inside thread keys, and they break every /^...$/m used below to find where
     a quoted reply starts — so the quoting is kept and every promise in it re-read. */
  raw = raw.replace(/\r\n/g, '\n');
  var split = raw.indexOf('\n\n');
  if (split < 0) return null;

  var head = {};
  raw.slice(0, split)
    /* Headers fold onto continuation lines that begin with whitespace — a long To:
       list is routinely split across three of them. Unfold before parsing or the
       recipients after the first line are silently lost. */
    .replace(/\n[ \t]+/g, ' ')
    .split('\n').forEach(function (line) {
      var i = line.indexOf(':');
      if (i > 0) head[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    });

  var date = when(head.date);
  var from = addresses(head.from)[0];
  if (!date || !from) return null;

  var body = raw.slice(split + 2);
  if (/quoted-printable/i.test(head['content-transfer-encoding'] || '')) body = decodeQP(body);
  body = unquote(body);
  if (!body) return null;

  return {
    id: head['message-id'] || file,
    threadId: threadOf(head.subject),
    subject: head.subject || '(no subject)',
    from: from,
    to: addresses(head.to).concat(addresses(head.cc)),
    date: date,
    body: body,
    sent: /sent/i.test(head['x-folder'] || ''),
    attach: false          // the released corpus carries no attachments
  };
}

/* Every message in one person's maildir, oldest first, de-duplicated by Message-ID —
   the same mail appears in several folders (sent, all documents, a project folder). */
function mailbox(dir) {
  var out = [], seen = {};
  var walk = function (d) {
    var entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    entries.forEach(function (ent) {
      var p = path.join(d, ent.name);
      if (ent.isDirectory()) return walk(p);
      var m = parse(p);
      if (m && !seen[m.id]) { seen[m.id] = 1; out.push(m); }
    });
  };
  walk(dir);
  return out.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
}

/* Whose mailbox this is. Taken from what they actually sent rather than from the
   directory name, which is a surname-initial slug and not an address. */
function owner(messages) {
  var tally = function (sentOnly) {
    var count = {}, best = null;
    messages.forEach(function (m) {
      if (sentOnly && !m.sent) return;
      if (!/@enron\.com$/.test(m.from || '')) return;
      count[m.from] = (count[m.from] || 0) + 1;
      if (!best || count[m.from] > count[best]) best = m.from;
    });
    return best;
  };
  /* Their own Sent folder first. Taking the commonest sender overall picks whoever
     mailed them most instead — which in a delegated or shared mailbox is somebody
     else entirely, and getting this wrong inverts every direction call in the
     detector: their promises become yours and yours become theirs. */
  return tally(true) || tally(false);
}

module.exports = { parse: parse, mailbox: mailbox, owner: owner, when: when, unquote: unquote, threadOf: threadOf };
