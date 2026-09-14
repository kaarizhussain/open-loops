/* The digest, as text — shared by every runtime.
 *
 * This used to live inside the Apps Script runner, which was fine while Gmail was the
 * only source. It is not fine with two, because the rendering is the product: the
 * ordering, the numbering that replies quote back, the line that says what changed.
 * Two copies of that drift, and the second one drifts silently.
 *
 * Nothing here touches a mailbox, a spreadsheet or a clock. Everything it needs is on
 * the object it is handed:
 *
 *   { today, messages[], events[], result: {open[], closed[]}, briefs[],
 *     ledger: {fresh, suppressed, gone[]}, read: {threads, capped, cap},
 *     marked, source, ledgerUrl, replyKey }
 *
 * `OWNER` and `LABEL` come from loops.js as free variables, the same way ledger.js
 * uses loopKey — in Apps Script every file shares one global scope, and in node the
 * tests assign them before requiring this.
 *
 * The shape, since 2026-09-14: a spotlight, a line of counts, then the piles — and every
 * loop appears once. The digest had grown into a report on the detector; this is the
 * version an assistant can take in within ten seconds, and it keeps the evidence: every
 * item quotes its sentence, says who said it and where, and says where a borrowed
 * deadline came from.
 */

/* Who acts next, in the order an assistant would want to read it: what only the
 * executive can do first because it is short and needs protecting, then the chases,
 * then the long list you can absorb yourself. */
var OWNER_ORDER = ['exec', 'them', 'you'];

/* Name the pile after the person, when there is a person to name.
 *
 * "Needs the executive" is right when you support someone unnamed, wrong when you
 * support Dana, and nonsense when you support nobody — in which case nothing lands
 * in that pile at all and the heading never prints. */
function ownerTitle(key, principals) {
  if (key !== 'exec' || !principals || !principals.length) return OWNER[key].title;
  return principals.length === 1
    ? 'Needs ' + principals[0].label
    : OWNER.exec.title;          // several: the name goes on each item instead
}

/* Enough of a message to judge it, not so much that five of them bury the list. */
function shortenBody(s, n) {
  var t = String(s || '').replace(/\s+/g, ' ').trim();
  n = n || 96;
  return t.length > n ? t.slice(0, n - 1).replace(/[,;:\s]+\S*$/, '') + '…' : t;
}

/* An action list that wraps is not a list you can scan, which is its only job. */
function pad(s, n) { while (s.length < n) s += ' '; return s; }
// The headline is the one line everybody reads, and "1 days past" reads as a bug in it.
function days(n) { return n + (n === 1 ? ' day' : ' days'); }

/* Dates as a reader says them. "Thu" is read at a glance; "2026-09-17" is decoded. A
 * weekday is only unambiguous within a week either side of today, so beyond that it is
 * the date. */
var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
var MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function utc(iso) { return new Date(String(iso).slice(0, 10) + 'T00:00:00Z'); }
function dayLabel(iso, today) {
  if (!iso) return '';
  var d = utc(iso);
  if (isNaN(d)) return String(iso);
  return Math.abs(Math.round((d - utc(today)) / 864e5)) <= 6
    ? DOW[d.getUTCDay()] : d.getUTCDate() + ' ' + MONTH[d.getUTCMonth()];
}

/* One sentence naming the worst of it, before any counts.
 *
 * Now only for an empty list — a list with anything on it opens with FIRST, which names
 * the item and the move rather than describing them. */
function headline(open, source) {
  if (!open.length) return 'Nothing outstanding. Genuinely — the list is empty.';

  var late = open.filter(function (l) { return l.status === 'overdue'; })
                 .sort(function (a, b) { return b.overdueDays - a.overdueDays; });
  /* An email subject describes the thing. A Slack "subject" is the channel name, and a
   * whole workspace shares a handful of those — so this line, which is the one line
   * everybody reads, said "the oldest by 2 days is #all-open-loops" and named nothing
   * that was actually late. On Slack the commitment itself is the only identifier. */
  var name = function (l) {
    return (source === 'slack' ? shortenBody(l.what, 52) : l.subject) +
      (l.rel ? ' (' + l.rel.label + ')' : '');
  };
  /* A trimmed commitment already ends in an ellipsis, and the sentence around it added
   * a full stop on top — "share it…." Only close what is still open. */
  var stop = function (s) { return /[.!?…]$/.test(s) ? s : s + '.'; };

  if (late.length) {
    var worst = late[0];
    return late.length === 1
      ? stop('One thing is overdue: ' + name(worst) + ', ' + days(worst.overdueDays) + ' past')
      : stop(late.length + ' are overdue. The oldest by ' + days(worst.overdueDays) +
        ' is ' + name(worst));
  }

  var soon = open.filter(function (l) { return l.status === 'due_today'; });
  if (soon.length) {
    return stop('Nothing overdue. ' + soon.length + (soon.length === 1 ? ' thing lands' : ' things land') +
      ' today, starting with ' + name(soon[0]));
  }

  // No deadline pressure at all, so the useful signal is what has gone quiet longest.
  var stale = open.slice().sort(function (a, b) { return (b.ageDays || 0) - (a.ageDays || 0); })[0];
  return stop('Nothing overdue and nothing due today. The quietest is ' + name(stale) +
    ', untouched for ' + days(stale.ageDays));
}

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

/* What FIRST spotlights. It answers a different question from the piles.
 *
 * The piles answer "what is outstanding, and who acts next" — a status question. At
 * nine in the morning the question is "what do I do in the next hour", and no amount of
 * sorting a forty-item list answers that. This is selection rather than ordering.
 *
 * One per counterparty, because chasing three people about five things is three
 * messages rather than five. Taking the top five by risk alone can hand you five lines
 * that are all the same conversation, which is one move dressed up as five. */
function actionList(open, limit) {
  var seen = {}, out = [];
  open.forEach(function (l) {
    if (out.length >= limit) return;
    var party = String(l.who || l.subject || '').toLowerCase();
    if (seen[party]) return;
    seen[party] = 1;
    out.push(l);
  });
  return out;
}

/* What the move is, rather than what the commitment said. "Chase Lena" is an
 * instruction; the sentence beside it is the evidence.
 *
 * The verb comes from the signal type, which is the only place it can honestly come
 * from. Where nobody is attributed there is no name to lead with — "Chase them" reads
 * correctly, but "them — I'm going to draft the onboarding doc" was a placeholder
 * printed where a name goes, so a promise of your own to nobody in particular says so. */
function move(l, nm) {
  var who = nm(l.who) || (l.rel ? l.rel.label : null);
  if (who && who.indexOf('@') > -1) who = callName(who, l);
  var q = '"' + shortenBody(l.what, 60) + '"';
  if (l.type === 'unprepped_meeting') return 'Send an agenda — ' + l.subject;
  if (l.type === 'no_followup') return 'Send a recap to ' + (who || 'them');
  if (l.type === 'agreed_unscheduled') return 'Get it booked — ' + q;
  if (l.type === 'unanswered_ask') return 'Answer ' + (who || 'them') + ' — ' + q;
  if (l.owner === 'them') return 'Chase ' + (who || 'them') + ' — ' + q;
  if (l.owner === 'exec') {
    return 'Needs ' + (l.principal ? l.principal.label : 'the executive') + ' — ' + q;
  }
  return (who ? 'You owe ' + who + ' — ' : 'You promised — ') + q;
}

/* "paul.oyelaran@meridianhealth.com" → "Paul". Wrong sometimes, and a note that opens
 * with the wrong name is worse than one that opens with none — so role addresses and
 * anything too short to be a name get no greeting rather than a guess. */
var ROLE = /^(info|team|hello|hi|no-?reply|notifications?|support|sales|hr|admin|billing|help|contact|office|accounts|legal|press|careers|jobs)$/i;

function firstName(addr) {
  var local = String(addr || '').split('@')[0];
  if (!local || ROLE.test(local)) return null;
  var first = local.split(/[._+-]/)[0];
  if (first.length < 2 || /\d/.test(first)) return null;
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

/* People by the name they go by. The display name a chat message carries beats one
 * guessed off an address, and the address stays the fallback. Two people who share a
 * first name both keep their addresses — a digest that tells you to chase "Sam" when
 * there are two is wrong in the way that costs the most. */
function nameBook(messages, items) {
  var named = {}, addrs = {}, holders = {};
  (messages || []).forEach(function (m) {
    var a = m && m.from ? String(m.from).toLowerCase() : '';
    if (a && m.fromName && !named[a]) named[a] = String(m.fromName).trim().split(/\s+/)[0];
  });
  items.forEach(function (l) {
    [l.who, l.closedByWho, l.dueFrom && l.dueFrom.from].forEach(function (a) {
      if (a && String(a).indexOf('@') > -1) addrs[String(a).toLowerCase()] = 1;
    });
  });
  Object.keys(addrs).forEach(function (a) {
    if (!named[a]) named[a] = firstName(a);
    var n = named[a] && named[a].toLowerCase();
    if (n) (holders[n] = holders[n] || {})[a] = 1;
  });
  return function (who) {
    if (!who) return null;
    var a = String(who).toLowerCase();
    if (a.indexOf('@') < 0) return String(who);       // already a name: "Sarah", "you"
    var n = named[a];
    return n && Object.keys(holders[n.toLowerCase()] || {}).length === 1 ? n : String(who);
  };
}

/* Someone with no usable first name, in a word. The company for a role address — "People
 * team" for hr@ — and otherwise the part before the @: "Chase j.mercer" says who, where
 * "Chase Partner" reads as a person called Partner. The full address is on the line
 * underneath either way. */
function callName(addr, l) {
  var local = String(addr).split('@')[0];
  return ROLE.test(local) && l.rel && String(addr).toLowerCase() === String(l.who || '').toLowerCase()
    ? l.rel.label : local;
}

/* Who said it, and what. Every item is a sentence somebody wrote, quoted as written —
 * that is what lets a reader check the list against the conversation in seconds. A
 * meeting signal is the exception: nothing was said, so there is nothing to quote. */
var QUIET = { unprepped_meeting: 1, no_followup: 1 };
function saidByThem(l) { var t = l.openType || l.type; return t === 'owed_to_us' || t === 'unanswered_ask'; }
function lead(l, nm) {
  var type = l.openType || l.type;
  if (QUIET[type]) return l.what;
  var q = '"' + l.what + '"';
  if (type === 'awaiting_reply') return 'You asked: ' + q;
  if (type === 'unanswered_ask') return (nm(l.who) || 'They') + ' asked: ' + q;
  if (type === 'owed_to_us') return (nm(l.who) || 'They') + ': ' + q;
  return 'You: ' + q;
}

/* Why it believes the date. A deadline the sentence states needs no note; one it
 * borrowed does — "date from Lena's 'by Tuesday'" — or the reader cannot tell a real
 * deadline from the detector's guess.
 *
 * ponytail: the phrase is picked out by its own small pattern, not by parseDue, so a
 * wording parseDue resolves and this does not falls back to the sentence, shortened. */
var DUE_WORDS = /\b(?:(?:by|before|on|until|due)\s+)?(?:(?:the\s+)?end of (?:the\s+)?(?:day|week)|eod|eow|today|tomorrow|this week|next week|(?:mon|tues|wednes|thurs|fri|satur|sun)day|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?|the\s+\d{1,2}(?:st|nd|rd|th))\b/i;
function duePhrase(s) { var m = String(s).match(DUE_WORDS); return m ? m[0] : shortenBody(s, 40); }
function evidence(l, nm) {
  var out = [];
  if (l.dueFrom) {
    var from = nm(l.dueFrom.from);
    if (from && from.indexOf('@') > -1) from = callName(l.dueFrom.from, l);
    out.push(l.dueFrom.same
      ? '"' + shortenBody(l.dueFrom.text, 40).replace(/[.!]$/, '') + '"'
      : 'date from ' + (from || 'them') + '\'s "' + duePhrase(l.dueFrom.text) + '"');
  }
  if ((l.openType || l.type) === 'agreed_unscheduled') out.push('agreed, not yet booked');
  return out;
}

/* The line under each item: how long it has sat, whose it is, who it is with, where it
 * was said and when, and the evidence. NEW only when it tells you something — on a first
 * run everything is new, and a tag on every line is a tag on none. */
function meta(l, nm, ctx) {
  var parts = [];
  var tracked = ctx.mixed && l.isNew ? 'NEW' : !l.isNew && l.trackedDays > 0 ? l.trackedDays + 'd on the list' : null;
  if (tracked) parts.push(tracked);
  // With several principals the heading cannot name one, so each item does.
  if (ctx.many && l.principal) parts.push('for ' + l.principal.label);
  // The person, unless they are already named as the one who said it.
  if (!saidByThem(l) && nm(l.who)) parts.push(nm(l.who));
  if (l.rel) parts.push(l.rel.label);
  parts.push(l.subject + (ctx.slack && l.threadId && l.threadId !== l.subject ? ', in a thread' : ''));
  if (l.said) parts.push(dayLabel(l.said, ctx.today));
  return parts.concat(evidence(l, nm)).join(' · ');
}

/* The note to send, where sending a note is the move.
 *
 * This is the step between reading the list and the list changing. Without it an item
 * only leaves when a message happens to appear — so anything handled by phone, or done
 * quietly, nags forever. The alternative fix is a "done" button, and that is worse: it
 * bypasses closure detection instead of feeding it. Paste this, send it, and the next
 * run sees your message and closes the loop by itself.
 *
 * Not every item gets one. A promise of your own that is not yet late needs doing, not
 * announcing, and an agenda needs writing rather than mentioning — offering a draft
 * there would be suggesting a message instead of the work.
 *
 * ponytail: the demo page carries its own richer variant with a subject line and
 * formatted dates, because it renders into a copy button rather than one digest line.
 * Two implementations, and they will drift; fold them together if a third appears. */
function draft(l) {
  var late = l.status === 'overdue' || l.status === 'due_today';
  var body = {
    /* Kept short enough to fit one line of the digest without wrapping, which is also
     * about the length anyone actually sends. A draft you have to edit down is one you
     * rewrite instead of pasting. */
    owed_by_us: late ? 'I still owe you this — sending it today, sorry for the lag.' : null,
    owed_to_us: late
      ? 'checking in on this — anything holding it up your end?'
      : 'just confirming this is still on track?',
    unanswered_ask: 'sorry for the slow reply — coming back to you today.',
    awaiting_reply: 'bumping this one — any thoughts when you get a moment?',
    agreed_unscheduled: 'shall I put some time in the diary for this?',
    no_followup: 'thanks for the time — recapping what we agreed below.',
    unprepped_meeting: null
  }[l.type];
  if (!body) return null;
  var name = firstName(l.who);
  // With no greeting the body has to start a sentence rather than continue one.
  return name ? 'Hi ' + name + ' — ' + body : body.charAt(0).toUpperCase() + body.slice(1);
}

function when(l, today) {
  return !l.due ? (l.ageDays > 6 ? 'quiet ' + l.ageDays + 'd' : 'no date')
    : l.status === 'overdue' ? l.overdueDays + 'd late'
    : l.status === 'due_today' ? 'today' : dayLabel(l.due, today);
}

/* Number, status, text — the status in a column of its own, so lateness is read down
 * one edge of the list. The number leads because it is what a reply quotes back. */
var IND = '               ';
function row(n, status, text) {
  return (n ? (n < 10 ? ' ' + n : '' + n) : '  ') + '  ' + pad(status, 9) + '  ' + text;
}

function render(b) {
  var L = [], p = function (s) { L.push(s == null ? '' : s); };
  var r = b.result, open = r.open, today = b.today;
  var read = b.read || {};
  var nm = nameBook(b.messages, open.concat(r.closed || []));
  var ctx = { today: today, slack: b.source === 'slack', many: (b.principals || []).length > 1,
              mixed: !!(b.ledger && b.ledger.fresh > 0 && b.ledger.fresh < open.length) };

  var t0 = utc(today);
  p('OPEN LOOPS — for ' + today + (isNaN(t0) ? '' : ' · ' + DOW[t0.getUTCDay()]));
  p('');
  /* Conversations were handed over and not one message came back out of them.
   *
   * "Nothing outstanding. Genuinely" is an assertion of confidence, and this is the
   * one case where it is certainly false: the reader is being told the list is empty
   * by something that could not read the input. The likeliest cause is the connector's
   * display format moving — src/slack.js parses a presentation format nobody documents
   * or promises to keep — and that failure is total and silent, so every channel comes
   * back empty at once and the digest looks like a quiet week. */
  var blind = !b.messages.length && read.threads > 0;

  /* FIRST — the spotlight, and the one section everybody reads.
   *
   * One item on a short list; on a long one, one move per counterparty, up to
   * `actionList`. Every loop appears once: a spotlit item is not printed again in its
   * pile, only pointed at, so the digest never reads as the same list twice. Numbered
   * from the full list, so replying "4" means the same thing wherever you read it. */
  var cap = b.actionList === undefined ? 5 : b.actionList;
  var spot = blind || !open.length ? [] : actionList(open, open.length > 8 && cap ? cap : 1);
  var drafted = false;
  if (blind) {
    p('READ NOTHING — ' + read.threads + ' conversation' + (read.threads === 1 ? ' was' : 's were') +
      ' handed over and no message could be parsed out of any of them. This is not a' +
      ' quiet day. Until it is fixed this digest can say nothing about what is' +
      ' outstanding, so treat the empty list below as unknown rather than clear.');
  } else if (!spot.length) {
    p(headline(open, b.source));
  } else {
    p(spot.length > 1 ? 'FIRST — one move each, most pressing first' : 'FIRST');
    spot.forEach(function (l) {
      p(row(l.n, when(l, today), move(l, nm)));
      p(IND + meta(l, nm, ctx));
      // Only where a note is the move. Paste it, send it, and the next run sees the
      // message and closes the loop without anyone ticking anything.
      var note = draft(l);
      if (note) { p(IND + '→ ' + note); drafted = true; }
    });
  }
  p('');

  /* The state of the day in one line: how much is late, how much lands soon, how much
   * there is. What changed since the last run rides on the end, because the rest of this
   * is the same list it was and a reader who knows that will not scan it again. */
  var t = utc(today), toFri = isNaN(t) ? 0 : (5 - t.getUTCDay() + 7) % 7;
  var fri = toFri ? new Date(+t + toFri * 864e5).toISOString().slice(0, 10) : null;
  var counts = [];
  var over = open.filter(function (l) { return l.status === 'overdue'; }).length;
  var dueNow = open.filter(function (l) { return l.status === 'due_today'; }).length;
  var soon = fri ? open.filter(function (l) {
    return l.due && l.status !== 'overdue' && l.status !== 'due_today' && l.due > today && l.due <= fri;
  }).length : 0;
  if (over) counts.push(over + ' overdue');
  if (dueNow) counts.push(dueNow + ' due today');
  if (soon) counts.push(soon + ' due by Fri');
  counts.push(open.length + ' open');
  if (b.ledger) {
    if (ctx.mixed) counts.push(b.ledger.fresh + ' new');
    if (b.ledger.gone.length) counts.push(b.ledger.gone.length + ' cleared');
    if (b.ledger.aged && b.ledger.aged.length) counts.push(b.ledger.aged.length + ' aged out');
    if (b.ledger.suppressed) counts.push(b.ledger.suppressed + ' hidden as wrong');
  }
  p(counts.join(' · '));

  /* Say the reply landed. Correcting something and seeing no acknowledgement is how
   * a reader learns the correction does not matter, and then they stop sending them. */
  if (b.marked) {
    p('Took your last reply — ' + b.marked + (b.marked === 1 ? ' item' : ' items') +
      ' marked wrong and dropped for good.');
  }

  /* Warnings stay at the top. Each one changes how far the list below can be trusted,
   * and a caveat read after the list is a caveat read too late. */
  /* The calendar response could not be read at all. Two of the seven signals live in the
   * gap between messages and meetings, so both are off for this run — and "0 meetings"
   * would otherwise read as a quiet diary. */
  if (read.calendarError) {
    p('CALENDAR NOT READ — the calendar response could not be parsed, so unprepped' +
      ' meetings and unbooked calls were not checked this run.');
  }
  /* Handed over and empty. Only worth a line when some other channel did parse —
     when none did, the READ NOTHING line has already said it in stronger terms
     and naming all of them again is the same news twice. */
  if (!blind && (read.unread || []).length) {
    p('NOTHING READ IN ' + read.unread.slice(0, 6).join(', ') +
      ((read.unread.length > 6) ? ' and ' + (read.unread.length - 6) + ' more' : '') +
      ' — either nobody has posted there, or the read came back empty. Those look the' +
      ' same from here, and only one of them is fine.');
  }
  /* A read that did not reach the start of the window.
   *
   * The fetch takes a fixed number of newest messages, so a busy channel hands back
   * three days where three weeks were asked for. Everything older is simply absent —
   * and absence is exactly what the ledger reads as CLEARED. A promise made a
   * fortnight ago would be reported as done, by a tool built to catch the thing
   * nobody finished. Saying which channels and how far back is the whole point: a
   * quiet channel and a truncated one look identical from here, and only the reader
   * can tell them apart. */
  (read.shortRead || []).slice(0, 4).forEach(function (s) {
    p('INCOMPLETE — ' + s.channel + ' was only read back to ' + s.from +
      ', not ' + (read.windowStart || 'the start of the window') +
      '. If it is busy rather than quiet, anything older is missing and may be' +
      ' reported as cleared.');
  });
  if (!(read.shortRead || []).length && read.capped) {
    p('INCOMPLETE — stopped at the ' + (read.cap || 'read') + ' limit. The oldest of it was ' +
      'not read, which is where overdue items live.');
  }
  /* Replies live behind a separate fetch, so a promise made inside a thread is simply
   * absent rather than wrong. A list that quietly omits things is worse than one that
   * says what it missed. */
  if (read.unfetchedThreads) {
    p('INCOMPLETE — ' + read.unfetchedThreads +
      (read.unfetchedThreads === 1 ? ' thread had replies that were not read.'
                                   : ' threads had replies that were not read.') +
      ' Anything promised inside them is missing from this list.');
  }
  /* A reply that named an item number but did not lead with it. Not acted on — "call
   * Dana at 3" is a note, and the self-DM is where notes live — but never silently, or
   * somebody retypes the same correction all week wondering why the item will not go
   * away. Being able to say this is what makes it safe to read replies strictly. */
  (b.ignoredReplies || []).slice(0, 3).forEach(function (line) {
    p('NOT READ AS A CORRECTION — "' + String(line).slice(0, 56) +
      '". Reply with just the number, like "3", to reject one.');
  });
  /* A signal with no evidence to reason about must say so. Chat gives a channel
   * roster where mail gives a recipient list, so "did a recap go out" is a question
   * this source cannot answer — and a silent nothing there reads identically to a
   * week where every meeting was followed up on. */
  if (b.dark && b.dark.no_followup) {
    p('NOT CHECKED — ' + b.dark.no_followup +
      (b.dark.no_followup === 1 ? ' past meeting was not checked' : ' past meetings were not checked') +
      ' for a follow-up. Recaps go out by mail and this run only read chat, so there is' +
      ' nothing here to tell a sent recap from an unsent one.');
  }
  /* A standing meeting that never carries an agenda is how that meeting is run, not a
   * fresh oversight every week. Suppressed rather than listed — but said out loud,
   * because a suppression nobody can see is indistinguishable from a rule that does
   * not work. */
  if (b.dark && b.dark.quietSeries) {
    p('Not listed: ' + b.dark.quietSeries +
      (b.dark.quietSeries === 1 ? ' recurring meeting has' : ' recurring meetings have') +
      ' no agenda, and no occurrence of theirs ever has. Put one on any occurrence and' +
      ' the series starts being checked.');
  }
  p('');

  var due = (b.briefs || []).filter(function (x) { return x.prepDue; });
  if (due.length) {
    p('NEEDS TO GO OUT TODAY');
    due.forEach(function (x) {
      p('  ' + (x.prepLate ? '[LATE] ' : '') + x.title + ' — ' +
        (x.inDays === 0 ? 'today' : x.inDays === 1 ? 'tomorrow' : 'in ' + x.inDays + ' days') +
        ', no agenda' + (x.attendees.length ? ' (' + x.attendees[0] + ')' : ''));
    });
    p('');
  }

  /* How many of each pile to actually print.
   *
   * Slack refuses a message over 4,000 characters, and a real mailbox goes far past
   * that: three Enron mailboxes rendered at 14,000, 29,000 and 29,000 characters — the
   * digest would not have been shortened, it would have failed to send, on somebody's
   * first day, with the runner correctly refusing to post half of one.
   *
   * The items are already risk-ordered and the ordering is already trusted — it is what
   * FIRST selects on. So this takes the top of each pile and says out loud what it held
   * back. Saying so is not decoration: a list that quietly stops is indistinguishable
   * from a quiet week, which is the failure this whole thing exists to prevent. */
  /* Off unless asked. The 4,000-character ceiling belongs to Slack, so the fitting is
   * the Slack runner's job — a renderer that silently truncates by default would hide
   * items from every other caller too, including the tests that check it shows all of
   * them. Passing 0 or nothing prints everything. */
  var perPile = b.listCap === undefined ? 0 : b.listCap;
  OWNER_ORDER.forEach(function (key) {
    var items = open.filter(function (l) { return l.owner === key; });
    if (!items.length) return;
    // "Yours to handle" says what it is; the other two need their one line of why.
    p(ownerTitle(key, b.principals).toUpperCase() + ' (' + items.length + ')' +
      (key === 'you' ? '' : ' — ' + OWNER[key].note));
    var held = perPile ? items.length - perPile : 0;
    (perPile ? items.slice(0, perPile) : items).forEach(function (l) {
      if (spot.indexOf(l) > -1) { p(row(l.n, when(l, today), '↑ FIRST')); return; }
      p(row(l.n, when(l, today), lead(l, nm)));
      p(IND + meta(l, nm, ctx));
      if (l.weekendShift) p(IND + 'note: stated ' + l.due + ' is a weekend — last working day is ' + l.workDue);
      /* Late by the letter, normal for them. Chasing here is the thing that makes an
       * assistant look careless to the people it matters most with. */
      if (l.earlyForThem) {
        p(IND + 'note: they usually take ' + l.usualDays + 'd — ' + l.ageDays +
          'd in, so this is not late for them yet');
      }
    });
    /* Never a silent trim. The count is the whole point of the line — "and 187 more"
     * tells a reader the tool is bounded, where a list that simply ends tells them
     * nothing and looks complete. */
    if (held > 0) {
      p('      … and ' + held + ' more in this pile, ranked below these. ' +
        'Raise `listCap` to see them.');
    }
    p('');
  });

  /* Dropped off the list since the last run. The only good news in here, which is
   * reason enough to keep it. */
  if (b.ledger && b.ledger.gone.length) {
    p('CLEARED SINCE THE LAST RUN (' + b.ledger.gone.length + ')');
    b.ledger.gone.forEach(function (g) {
      // Blank under storeText:false — say something rather than print an empty line.
      p('  ' + (g.what || '(text not kept)') + (g.who ? '  — ' + g.who : ''));
    });
    p('');
  }

  /* Not seen to close — only seen to leave the window. These were said before today's
   * read began, so their absence is no evidence of anything, and they must not share a
   * heading with the good news above. Listed once, so the reader can check them by hand;
   * the ledger will not raise them again. Bounded by the same knob as the piles, because
   * the first run after a long gap can age out a great many at once. */
  var aged = (b.ledger && b.ledger.aged) || [];
  if (aged.length) {
    p('AGED OUT, NOT CLEARED (' + aged.length + ') — said more than ' +
      (read.windowDays ? read.windowDays + ' days' : 'a read window') +
      ' ago, so this run could not see whether they closed. Check these by hand:');
    var agedShown = b.listCap ? aged.slice(0, b.listCap) : aged;
    agedShown.forEach(function (g) {
      p('  ' + (g.what || '(text not kept)') + (g.who ? '  — ' + g.who : ''));
    });
    if (agedShown.length < aged.length) p('  … and ' + (aged.length - agedShown.length) + ' more.');
    p('');
  }

  /* What closed, and what closed it. The closing message is the evidence — a list that
   * says only "closed" asks to be taken on trust, which is what the rest of it avoids. */
  if (r.closed.length) {
    p('CLOSED ITSELF (' + r.closed.length + ')');
    // Bounded by the same knob as the piles: on a busy mailbox this ran to ten entries
    // and 700 characters of good news, which is the cheapest thing to shorten.
    r.closed.slice(0, perPile || 10).forEach(function (l) {
      p('    ' + lead(l, nm));
      if (l.closedBy) {
        p('      closed ' + dayLabel(l.closedOn, today) + (l.closedByWho
          ? ' by ' + nm(l.closedByWho) + ': "' + l.closedBy + '"'
          : ': ' + l.closedBy));
      }
    });
    p('');
  }

  // The boundary everything above is judged inside, once the list has been read.
  p('Read ' + b.messages.length + ' messages' +
    (read.threads ? ' across ' + read.threads + (b.source === 'slack' ? ' conversations' : ' threads') : '') +
    ' and ' + b.events.length + ' meetings' +
    (read.windowDays ? ', going back ' + read.windowDays + ' days.' : '.') +
    // Deliberately out of scope, which is different from missed — say which.
    (read.skipped ? ' ' + read.skipped + ' left out of scope on purpose.' : ''));

  if (drafted) p('Drafts only — nothing here has been sent. Verify before acting on any of it.');

  /* How to answer it. In full until the reader has answered once — that paragraph is
   * what teaches the loop, and the loop is the only way this learns anything — then as a
   * two-line key, because the same explanation every evening is read once and then
   * skimmed past forever. */
  var brief = b.replyKey === 'short';
  if (!brief) {
    p('');
    p("Anything here that isn't real? Reply with just its number — \"3 7\" — and those");
    p('stop coming back. That reply is the only record of what this gets wrong.');
    p('Already knew about one? Put it on a line starting with k — "k 1 4". It stays on');
    p('the list; it just stops counting as something this told you.');
  }

  /* The only question in here that can say anything about what was missed. Everything
   * else asks about things that appeared, and a miss produces nothing to reject. */
  var checking = b.spotCheck && b.spotCheck.length;
  if (checking) {
    p('');
    p('SPOT CHECK — it found nothing in these. Did it miss something?');
    b.spotCheck.forEach(function (m, i) {
      p('  ' + String.fromCharCode(97 + i) + '  ' + pad(shortenBody(m.body, 60), 62) + (m.subject || ''));
    });
    if (!brief) {
      p('Reply "miss b d" for any that did contain a commitment, or "miss" on its own');
      p('if none did. Saying none is what makes the rest of it evidence.');
    }
  }
  if (brief) {
    p('');
    p('Reply   3 7  not real        k 1 4  already knew');
    if (checking) p('        miss b d  it missed those        miss  it missed nothing');
  }

  if (b.recall) {
    p('');
    p('Recall so far: about ' + b.recall.rate + '% — ' + b.recall.missed +
      ' misses found in ' + b.recall.checked + ' messages spot-checked.');
  }

  /* Anything the tool decided for itself is announced the run it happens and listed
   * in every run after. A rule that changes behaviour and is not on the page is the
   * one that makes a tool unpredictable — the change itself is fine. */
  if (b.learnedNow && b.learnedNow.length) {
    p('');
    p('LEARNED — these will not be raised again:');
    b.learnedNow.forEach(function (m) {
      p('  "' + m.phrase + '" — rejected ' + m.count + ' times, kept none');
    });
    p('Wrong about any of them? Add it to `unmute` and it comes straight back.');
  }

  /* Below the auto bar, so proposed rather than applied. */
  if (b.mutes && b.mutes.length) {
    p('');
    p('These turn up in things you rejected and in nothing you kept:');
    b.mutes.forEach(function (m) {
      p('  "' + m.phrase + '" — rejected ' + m.count + ' times');
    });
    p('Add any of them to `mute` and they stop being raised at all.');
  }

  if (b.muted) {
    p('');
    p(b.muted + (b.muted === 1 ? ' item was' : ' items were') + ' muted by phrase before this list was built.');
  }

  // Standing state that shapes every list, so it stays visible rather than implied.
  if (b.learnedAll && b.learnedAll.length) {
    p('Currently muting on its own: ' +
      b.learnedAll.map(function (m) { return '"' + m.phrase + '"'; }).join(', ') + '.');
  }
  if (b.ledgerUrl) p('Ledger: ' + b.ledgerUrl);
  return L.join('\n');
}

if (typeof module !== 'undefined') {
  module.exports = { render: render, headline: headline, digestOrder: digestOrder, ownerTitle: ownerTitle, actionList: actionList, draft: draft, firstName: firstName,
                     OWNER_ORDER: OWNER_ORDER };
}
