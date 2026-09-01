/* Open Loops — Apps Script runner.
 *
 * Runs inside the executive's own Google account, reads their mail and calendar,
 * and emails the digest to whoever supports them. Nothing is sent on anyone's
 * behalf and no data leaves the tenant. The one thing it writes is the ledger —
 * a spreadsheet in the same account, one row per detected item, holding a short
 * excerpt of the sentence that triggered it.
 *
 * SETUP
 *  1. script.google.com → New project
 *  2. Add six files: loops.js, digest.js and ledger.js (from ../src), then
 *     adapters.js, ledger-sheet.js and this one (from here)
 *  3. Fill in CONFIG
 *  4. Run `preview` by hand — it logs the digest without emailing anyone
 *  5. Run `installTrigger` once it looks right
 *  6. Run `precisionReport` after a fortnight to see how much of it was real
 *
 * Note this must live in the *executive's* account. Gmail delegation is a UI
 * feature, not an API one, so a script in the assistant's account cannot read a
 * mailbox that has merely been shared with them.
 */

var CONFIG = {
  exec: 'exec@yourcompany.com',      // whose mailbox this runs in
  sendTo: 'assistant@yourcompany.com', // who receives the digest
  lookbackDays: 21,                  // how far back to read threads
  lookaheadDays: 7,                  // how far ahead to read the calendar
  triggerHour: 18,                   // evening, so tomorrow starts set up

  // Automated senders manufacture false commitments. Add to this as you find them.
  ignoreSenders: ['noreply', 'no-reply', 'donotreply', 'notifications', 'mailer-daemon',
                  'calendar-notification', 'automated'],

  /* What must never be read. Set by whoever owns the mailbox — an executive's inbox
   * carries comp discussions, HR matters, board threads and worse, and delegated
   * access is a person with judgement choosing what to open. This is automated
   * extraction and forwarding, which is a different thing nobody has agreed to.
   *
   * Labels are the useful one: apply them in Gmail, and threads carrying them never
   * enter the pipeline. */
  exclude: {
    labels: [],       // e.g. ['Private', 'HR', 'Board']
    senders: []       // addresses or whole domains, e.g. ['legal@company.com', 'clinic.org']
  },

  /* Strict allowlist. When non-empty, ONLY correspondence with these addresses or
   * domains is read, and everything else is invisible. Default-deny — the right
   * setting for a regulated environment, and unusable for general use. */
  only: [],

  /* How long the ledger keeps a row after the detector stops matching it. The ledger
   * holds excerpts of mail, so retention policy and eDiscovery reach it and "forever"
   * is not an answer anyone accepts. Age runs from when an item was last detected,
   * so nothing still live is ever pruned. */
  keepLedgerDays: 90,

  /* Set false to keep the key and the verdict but not the words. Rejecting an item
   * still works; what is lost is the cleared-items list being readable. */
  storeText: true,

  // Who matters, curated by hand — the tool should not guess this.
  contacts: {
    // 'cfo@yourcompany.com':  { tier: 'exec',        label: 'CFO' },
    // 'keyaccount.com':       { tier: 'key_account', label: 'Key account' }
  }
};

function stamp(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm");
}
function today() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}
function ignored(from) {
  var local = String(from).split('@')[0].toLowerCase();
  return CONFIG.ignoreSenders.some(function (bad) { return local.indexOf(bad) > -1; });
}

/* Gmail will not tell you how much you missed. GmailApp exposes no match total at all,
 * and the Gmail API's own estimate is no help either — checked through a connector, a
 * seven-day and a twenty-one-day query returned an identical figure. So the only honest
 * signal available is noticing that the search came back full.
 *
 * ponytail: warns rather than paginates. Paging a large mailbox risks the six-minute
 * execution limit, and failing outright is worse than reading less and saying so.
 * Paginate if this starts firing at a lookback someone actually needs.
 */
var READ_CAP = 300;
var lastRead = { threads: 0, capped: false, cap: READ_CAP };

/* Gmail search terms need quoting once they contain a space. */
function term(op, value) {
  var v = String(value).trim();
  return op + (/\s/.test(v) ? '"' + v + '"' : v);
}

/* The exclusions, as query. Cheaper than filtering afterwards and it means the
 * excluded mail is never fetched in the first place. */
function scopeQuery() {
  var ex = CONFIG.exclude || {}, q = '';
  (ex.labels || []).forEach(function (l) { q += ' -' + term('label:', l); });
  (ex.senders || []).forEach(function (s) { q += ' -' + term('from:', s); });

  var only = CONFIG.only || [];
  if (only.length) {
    // Braces are Gmail's OR. Either side of the correspondence counts as a match.
    var parts = [];
    only.forEach(function (p) { parts.push(term('from:', p), term('to:', p)); });
    q += ' {' + parts.join(' ') + '}';
  }
  return q;
}

/* A label on any message in a thread hides the whole thread.
 *
 * The query alone is not enough. Gmail matches at thread level, so a thread where
 * only one message carries an excluded label can still come back — the same quirk
 * its own documentation warns about for -is:starred. Getting this wrong forwards
 * the one thread somebody specifically marked private, so it is checked twice. */
function threadExcluded(thread) {
  var names = (CONFIG.exclude && CONFIG.exclude.labels) || [];
  if (!names.length) return false;
  var block = {};
  names.forEach(function (n) { block[String(n).toLowerCase()] = 1; });
  return thread.getLabels().some(function (l) { return block[l.getName().toLowerCase()]; });
}

/* Senders excluded by address or by whole domain. */
function senderExcluded(from) {
  return ((CONFIG.exclude && CONFIG.exclude.senders) || []).some(function (s) {
    var t = String(s).toLowerCase();
    return from === t || from.split('@')[1] === t;
  });
}

function readMessages() {
  var q = 'newer_than:' + CONFIG.lookbackDays + 'd -in:chats -in:spam -in:trash' +
          ' -category:promotions -category:social' + scopeQuery();
  var out = [];
  var threads = GmailApp.search(q, 0, READ_CAP);
  lastRead = { threads: threads.length, capped: threads.length >= READ_CAP,
               cap: READ_CAP + '-thread', skipped: 0 };
  threads.forEach(function (thread) {
    if (threadExcluded(thread)) { lastRead.skipped++; return; }
    var tid = thread.getId();
    thread.getMessages().forEach(function (m) {
      var from = addr(m.getFrom());
      if (ignored(from) || senderExcluded(from)) return;
      out.push({
        id: m.getId(), threadId: tid, subject: m.getSubject() || '(no subject)',
        from: from, to: addrList(m.getTo()),
        date: stamp(m.getDate()),
        body: cleanBody(m.getPlainBody()),   // quoted replies stripped — see adapters.js
        attach: m.getAttachments({ includeInlineImages: false }).length > 0
      });
    });
  });
  return out;
}

function readEvents() {
  var from = new Date(Date.now() - 14 * 864e5);
  var to = new Date(Date.now() + CONFIG.lookaheadDays * 864e5);
  return CalendarApp.getDefaultCalendar().getEvents(from, to).map(function (e) {
    return {
      id: e.getId(), title: e.getTitle(), start: stamp(e.getStartTime()),
      attendees: e.getGuestList(true).map(function (g) { return g.getEmail().toLowerCase(); }),
      agenda: String(e.getDescription() || '').trim().length > 0
    };
  });
}

/* `persist` is false for preview, so reading the digest by hand never writes a
 * run into the ledger — otherwise the first real send would report nothing as new. */
function build(persist) {
  var messages = readMessages();
  var events = readEvents();
  var opts = { exec: CONFIG.exec.toLowerCase(), today: today(), contacts: CONFIG.contacts };
  var result = detectLoops(messages, events, opts);

  /* Merge before the briefs are built, or an item the reader marked wrong is
   * suppressed from the main list and then reappears under its meeting. */
  var sh = ledgerSheet(), rows = readLedger(sh);
  // Yesterday's corrections land before today's list is built, or a rejected item
  // would appear one more time before disappearing.
  var marked = applyReplies(rows, persist);
  var ledger = mergeLedger(rows, result.open, opts.today, { storeText: CONFIG.storeText });
  result.open = ledger.shown;
  // After the merge, so anything still being detected has just had its clock reset.
  var pruned = pruneLedger(rows, opts.today, CONFIG.keepLedgerDays);
  var keys = digestOrder(result.open);
  if (persist) {
    writeLedger(sh, rows);
    rememberDigest(opts.today, keys);
  }

  var briefs = meetingBriefs(messages, events, result.open, opts);
  // `today` travels on the object so the renderer never has to read a clock.
  return { today: opts.today, source: 'gmail',
           messages: messages, events: events, result: result, briefs: briefs,
           ledger: ledger, ledgerUrl: sh.getParent().getUrl(), read: lastRead,
           marked: marked, pruned: pruned };
}

/* Replies to previous digests, turned into verdicts.
 *
 * The digest is sent from this account, so replies to it land back here and the
 * existing mail read can see them. Resolved against the date in the subject line —
 * a reply carries that back even when the list underneath has completely changed. */
function applyReplies(rows, persist) {
  var reader = CONFIG.sendTo.toLowerCase(), marked = 0;
  var seen = seenReplies(), known = {};
  seen.forEach(function (id) { known[id] = 1; });

  GmailApp.search('subject:"Open loops" newer_than:8d', 0, 20).forEach(function (thread) {
    var msgs = thread.getMessages();
    var stamp = String(msgs[0].getSubject() || '').match(/Open loops[^0-9]*(\d{4}-\d{2}-\d{2})/);
    if (!stamp) return;
    var keys = recallDigest(stamp[1]);
    if (!keys.length) return;                       // no memo, nothing to resolve against
    msgs.slice(1).forEach(function (r) {
      if (addr(r.getFrom()) !== reader) return;     // only the person the digest was for
      var id = r.getId();
      if (known[id]) return;                        // already acted on, on an earlier run
      known[id] = 1; seen.push(id);
      // cleanBody strips the quoted digest, or every number in it would count as a mark.
      marked += applyMarks(rows, keys, parseMarks(cleanBody(r.getPlainBody()), keys.length));
    });
  });

  // Only on a real run: preview must not consume a reply the next send should act on.
  if (persist) rememberReplies(seen);
  return marked;
}

/* Run this by hand first. Logs the digest, emails nobody, records nothing. */
function preview() {
  var text = render(build(false));
  Logger.log(text);
  return text;
}

/* How much of it was real. Run it after the fortnight, before anyone depends on this. */
function precisionReport() {
  var p = precision(readLedger(ledgerSheet()));
  var L = ['OPEN LOOPS — how it did', '', 'Tracked ' + p.total + ' items.'];

  if (p.total) {
    var trust = Math.round((1 - p.wrong / p.total) * 100);
    var value = Math.round(p.news / p.total * 100);
    L.push('');
    L.push('  ' + p.wrong + ' wrong        → ' + trust + '% held up' +
           (trust < 80 ? '   under the bar. Fix it or stop.' : ''));
    L.push('  ' + p.knew + ' already known');
    L.push('  ' + p.news + ' genuinely new → ' + value + '% told you something');
    L.push('');
    /* Both numbers are needed. A tidy list of things the reader already knew is
     * accurate and pointless; a list that finds real misses but cries wolf gets
     * ignored by the third day. */
    L.push(trust >= 80 && value >= 20 ? 'Worth someone\'s morning.'
      : trust < 80 ? 'Not trusted enough yet — the wrong-rate is what to fix first.'
      : 'Accurate, but it is mostly telling you things you knew. Look further back,'
        + ' or rank differently, before adding anything.');
  }

  L.push('', 'By signal — real/total, and how many of those were news:');
  Object.keys(p.byType).sort().forEach(function (t) {
    var b = p.byType[t];
    L.push('  ' + (LABEL[t] || t) + ': ' + (b.total - b.wrong) + '/' + b.total +
           '  (' + (b.total - b.wrong - b.knew) + ' new)');
  });

  L.push('', 'Unmarked rows count as both correct and new, so this reads optimistically.');
  var text = L.join('\n');
  Logger.log(text);
  return text;
}

function run() {
  var b = build(true);
  var text = render(b);
  var late = b.result.open.filter(function (l) { return l.status === 'overdue'; }).length;
  MailApp.sendEmail({
    to: CONFIG.sendTo,
    // The new count is in the subject because it is the only reason to open this today.
    subject: 'Open loops — ' + today() + ' (' + b.result.open.length + ' open, ' + late +
             ' overdue, ' + b.ledger.fresh + ' new)',
    body: text
  });
  return text;
}

function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'run') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('run').timeBased().atHour(CONFIG.triggerHour).everyDays(1).create();
  Logger.log('Scheduled daily at ~' + CONFIG.triggerHour + ':00, emailing ' + CONFIG.sendTo);
}
