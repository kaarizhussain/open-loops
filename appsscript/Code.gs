/* Open Loops — Apps Script runner.
 *
 * Runs inside the executive's own Google account, reads their mail and calendar,
 * and emails the digest to whoever supports them. Nothing is stored, nothing is
 * sent on anyone's behalf, and no data leaves the tenant.
 *
 * SETUP
 *  1. script.google.com → New project
 *  2. Add three files: loops.js (from ../src), adapters.js, and this one
 *  3. Fill in CONFIG
 *  4. Run `preview` by hand — it logs the digest without emailing anyone
 *  5. Run `installTrigger` once it looks right
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

function readMessages() {
  var q = 'newer_than:' + CONFIG.lookbackDays + 'd -in:chats -in:spam -in:trash' +
          ' -category:promotions -category:social';
  var out = [];
  GmailApp.search(q, 0, 300).forEach(function (thread) {
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

function build() {
  var messages = readMessages();
  var events = readEvents();
  var opts = { exec: CONFIG.exec.toLowerCase(), today: today(), contacts: CONFIG.contacts };
  var result = detectLoops(messages, events, opts);
  var briefs = meetingBriefs(messages, events, result.open, opts);
  return { messages: messages, events: events, result: result, briefs: briefs };
}

var OWNER_ORDER = ['exec', 'them', 'you'];

function render(b) {
  var L = [], p = function (s) { L.push(s == null ? '' : s); };
  var r = b.result, open = r.open;

  p('OPEN LOOPS — for ' + today());
  p('Read ' + b.messages.length + ' messages and ' + b.events.length + ' meetings.');
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
      p('  [' + when + '] ' + l.what);
      p('      ' + (l.rel ? l.rel.label + ' · ' : '') + l.who + ' · ' + l.subject);
      if (l.weekendShift) p('      note: stated ' + l.due + ' is a weekend — last working day is ' + l.workDue);
    });
    p('');
  });

  if (r.closed.length) {
    p('CLOSED ITSELF (' + r.closed.length + ')');
    r.closed.slice(0, 10).forEach(function (l) { p('  ' + l.closedOn + '  ' + l.what); });
    p('');
  }

  p('Drafts only — nothing here has been sent. Verify before acting on any of it.');
  return L.join('\n');
}

/* Run this by hand first. Logs the digest, emails nobody. */
function preview() {
  var text = render(build());
  Logger.log(text);
  return text;
}

function run() {
  var b = build();
  var text = render(b);
  var late = b.result.open.filter(function (l) { return l.status === 'overdue'; }).length;
  MailApp.sendEmail({
    to: CONFIG.sendTo,
    subject: 'Open loops — ' + today() + ' (' + b.result.open.length + ' open, ' + late + ' overdue)',
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
