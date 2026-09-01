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
 *  2. Add four files: loops.js (from ../src), adapters.js, ledger.js, and this one
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
var lastRead = { threads: 0, capped: false };

function readMessages() {
  var q = 'newer_than:' + CONFIG.lookbackDays + 'd -in:chats -in:spam -in:trash' +
          ' -category:promotions -category:social';
  var out = [];
  var threads = GmailApp.search(q, 0, READ_CAP);
  lastRead = { threads: threads.length, capped: threads.length >= READ_CAP };
  threads.forEach(function (thread) {
    var tid = thread.getId();
    thread.getMessages().forEach(function (m) {
      var from = addr(m.getFrom());
      if (ignored(from)) return;
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
  var ledger = mergeLedger(rows, result.open, opts.today);
  result.open = ledger.shown;
  var keys = digestOrder(result.open);
  if (persist) {
    writeLedger(sh, rows);
    rememberDigest(opts.today, keys);
  }

  var briefs = meetingBriefs(messages, events, result.open, opts);
  return { messages: messages, events: events, result: result, briefs: briefs,
           ledger: ledger, ledgerUrl: sh.getParent().getUrl(), read: lastRead,
           marked: marked };
}

var OWNER_ORDER = ['exec', 'them', 'you'];

/* Number the items in the order the digest prints them, and record which loop each
 * number refers to. Stamping `n` on the loop itself means the numbering and the
 * recorded order cannot drift apart — render just prints what this assigned. */
function digestOrder(open) {
  var keys = [], n = 0;
  OWNER_ORDER.forEach(function (key) {
    open.filter(function (l) { return l.owner === key; }).forEach(function (l) {
      l.n = ++n;
      keys.push(loopKey(l));
    });
  });
  return keys;
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
      marked += markWrong(rows, keys, parseMarks(cleanBody(r.getPlainBody()), keys.length));
    });
  });

  // Only on a real run: preview must not consume a reply the next send should act on.
  if (persist) rememberReplies(seen);
  return marked;
}

function render(b) {
  var L = [], p = function (s) { L.push(s == null ? '' : s); };
  var r = b.result, open = r.open;

  p('OPEN LOOPS — for ' + today());
  p('Read ' + b.messages.length + ' messages' +
    (b.read && b.read.threads ? ' across ' + b.read.threads + ' threads' : '') +
    ' and ' + b.events.length + ' meetings.');
  /* Silent truncation would make a half-read mailbox look like a complete digest, and
   * the half it drops is the oldest — which is exactly where the overdue items are. */
  if (b.read && b.read.capped) {
    p('INCOMPLETE — stopped at the ' + READ_CAP + '-thread limit. The oldest mail in the ' +
      'window was not read, which is where overdue items live. Lower lookbackDays and rerun.');
  }
  /* What changed since yesterday, on the first line — the rest of this is the same
   * list it was, and a reader who already knows that will not scan it again. */
  if (b.ledger) {
    p(open.length + ' open · ' + b.ledger.fresh + ' new' +
      (b.ledger.gone.length ? ' · ' + b.ledger.gone.length + ' cleared' : '') +
      (b.ledger.suppressed ? ' · ' + b.ledger.suppressed + ' hidden as wrong' : ''));
  }
  /* Say the reply landed. Correcting something and seeing no acknowledgement is how
   * a reader learns the correction does not matter, and then they stop sending them. */
  if (b.marked) {
    p('Took your last reply — ' + b.marked + (b.marked === 1 ? ' item' : ' items') +
      ' marked wrong and dropped for good.');
  }
  p('');

  var due = b.briefs.filter(function (x) { return x.prepDue; });
  if (due.length) {
    p('NEEDS TO GO OUT TODAY');
    due.forEach(function (x) {
      p('  ' + (x.prepLate ? '[LATE] ' : '') + x.title + ' — ' +
        (x.inDays === 0 ? 'today' : x.inDays === 1 ? 'tomorrow' : 'in ' + x.inDays + ' days') +
        ', no agenda' + (x.attendees.length ? ' (' + x.attendees[0] + ')' : ''));
    });
    p('');
  }

  OWNER_ORDER.forEach(function (key) {
    var items = open.filter(function (l) { return l.owner === key; });
    if (!items.length) return;
    p(OWNER[key].title.toUpperCase() + ' (' + items.length + ') — ' + OWNER[key].note);
    items.forEach(function (l) {
      var when = !l.due ? 'no date'
        : l.status === 'overdue' ? l.overdueDays + 'd late'
        : l.status === 'due_today' ? 'today' : 'due ' + l.due;
      // The number is what you quote back to reject it, so it leads the line.
      var num = l.n ? (l.n < 10 ? ' ' + l.n : '' + l.n) + '. ' : '  ';
      p(num + '[' + when + '] ' + l.what);
      // How long this has been sitting here is its own kind of overdue.
      var tracked = l.isNew ? 'NEW' : l.trackedDays > 0 ? l.trackedDays + 'd on the list' : null;
      p('      ' + (tracked ? tracked + ' · ' : '') +
        (l.rel ? l.rel.label + ' · ' : '') + l.who + ' · ' + l.subject);
      if (l.weekendShift) p('      note: stated ' + l.due + ' is a weekend — last working day is ' + l.workDue);
    });
    p('');
  });

  /* Dropped off the list since the last run. The only part of this email that is
   * good news, which is reason enough to keep it in. */
  if (b.ledger && b.ledger.gone.length) {
    p('CLEARED SINCE THE LAST RUN (' + b.ledger.gone.length + ')');
    b.ledger.gone.forEach(function (row) {
      p('  ' + row[COL.what] + (row[COL.who] ? '  — ' + row[COL.who] : ''));
    });
    p('');
  }

  if (r.closed.length) {
    p('CLOSED ITSELF (' + r.closed.length + ')');
    r.closed.slice(0, 10).forEach(function (l) { p('  ' + l.closedOn + '  ' + l.what); });
    p('');
  }

  p('Drafts only — nothing here has been sent. Verify before acting on any of it.');
  p('');
  p("Anything here that isn't real? Reply with just its number — \"3 7\" — and those");
  p('stop coming back. That reply is also the only record of what this gets wrong.');
  if (b.ledgerUrl) p('Ledger: ' + b.ledgerUrl);
  return L.join('\n');
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
  var L = ['OPEN LOOPS — precision', '',
           'Tracked ' + p.total + ' items. ' + p.wrong + ' marked wrong.'];
  if (p.total) {
    var pct = Math.round((1 - p.wrong / p.total) * 100);
    L.push(pct + '% held up' + (pct < 80 ? ' — under the bar. Fix it or stop.' : '.'));
  }
  L.push('', 'By signal:');
  Object.keys(p.byType).sort().forEach(function (t) {
    var b = p.byType[t];
    L.push('  ' + (LABEL[t] || t) + ': ' + (b.total - b.wrong) + '/' + b.total);
  });
  L.push('', 'Unmarked rows count as correct, so this is the optimistic reading.');
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
