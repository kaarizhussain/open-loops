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
 *     marked, source, ledgerUrl }
 *
 * `OWNER` and `LABEL` come from loops.js as free variables, the same way ledger.js
 * uses loopKey — in Apps Script every file shares one global scope, and in node the
 * tests assign them before requiring this.
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

/* One sentence naming the worst of it, before any counts.
 *
 * A digest that opens with how many messages it read is a system reporting on itself.
 * Someone good at this job opens with the thing you would be most annoyed to discover
 * on Friday. The ranking already knows which item that is; this only has to say it. */
/* Enough of a message to judge it, not so much that five of them bury the list. */
function shortenBody(s, n) {
  var t = String(s || '').replace(/\s+/g, ' ').trim();
  n = n || 96;
  return t.length > n ? t.slice(0, n - 1).replace(/[,;:\s]+\S*$/, '') + '…' : t;
}

/* An action list that wraps is not a list you can scan, which is its only job. */
function pad(s, n) { while (s.length < n) s += ' '; return s; }

function headline(open) {
  if (!open.length) return 'Nothing outstanding. Genuinely — the list is empty.';

  var late = open.filter(function (l) { return l.status === 'overdue'; })
                 .sort(function (a, b) { return b.overdueDays - a.overdueDays; });
  var name = function (l) { return l.subject + (l.rel ? ' (' + l.rel.label + ')' : ''); };

  if (late.length) {
    var worst = late[0];
    return late.length === 1
      ? 'One thing is overdue: ' + name(worst) + ', ' + worst.overdueDays + ' days past.'
      : late.length + ' are overdue. The oldest by ' + worst.overdueDays +
        ' days is ' + name(worst) + '.';
  }

  var soon = open.filter(function (l) { return l.status === 'due_today'; });
  if (soon.length) {
    return 'Nothing overdue. ' + soon.length + (soon.length === 1 ? ' thing lands' : ' things land') +
      ' today, starting with ' + name(soon[0]) + '.';
  }

  // No deadline pressure at all, so the useful signal is what has gone quiet longest.
  var stale = open.slice().sort(function (a, b) { return (b.ageDays || 0) - (a.ageDays || 0); })[0];
  return 'Nothing overdue and nothing due today. The quietest is ' + name(stale) +
    ', untouched for ' + stale.ageDays + ' days.';
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

/* The short list at the top answers a different question from the long one below it.
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

/* What the move is, rather than what the commitment said. "Chase Meridian" is an
 * instruction; "We will have their comments back to you by Friday" is a quotation, and
 * a list of quotations still leaves you working out what to do with each one.
 *
 * The verb comes from the signal type, which is the only place it can honestly come
 * from — three of them name an action outright, and for a plain promise the sentence
 * already says what was promised, so naming who it is owed to is the useful half. */
function move(l) {
  var who = l.rel ? l.rel.label : (l.who || 'them');
  if (l.type === 'unprepped_meeting') return 'Send an agenda — ' + l.subject;
  if (l.type === 'no_followup') return 'Send a recap to ' + who;
  if (l.type === 'agreed_unscheduled') return 'Get it booked — ' + shortenBody(l.what);
  if (l.type === 'unanswered_ask') return 'Answer ' + who + ' — ' + shortenBody(l.what);
  if (l.owner === 'them') return 'Chase ' + who + ' — ' + shortenBody(l.what);
  if (l.owner === 'exec') {
    return 'Needs ' + (l.principal ? l.principal.label : 'the executive') +
      ' — ' + shortenBody(l.what);
  }
  return who + ' — ' + shortenBody(l.what);
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

function when(l) {
  return !l.due ? (l.ageDays > 6 ? 'quiet ' + l.ageDays + 'd' : 'no date')
    : l.status === 'overdue' ? l.overdueDays + 'd late'
    : l.status === 'due_today' ? 'today' : 'due ' + l.due;
}

function render(b) {
  var L = [], p = function (s) { L.push(s == null ? '' : s); };
  var r = b.result, open = r.open;
  var read = b.read || {};

  p('OPEN LOOPS — for ' + b.today);
  p('');
  p(headline(open));
  p('');

  p('Read ' + b.messages.length + ' messages' +
    (read.threads ? ' across ' + read.threads + (b.source === 'slack' ? ' conversations' : ' threads') : '') +
    ' and ' + b.events.length + ' meetings' +
    // How far back it looked is the boundary everything else is judged inside.
    (read.windowDays ? ', going back ' + read.windowDays + ' days.' : '.') +
    // Deliberately out of scope, which is different from missed — say which.
    (read.skipped ? ' ' + read.skipped + ' left out of scope on purpose.' : ''));

  /* Silent truncation would make a half-read mailbox look like a complete digest, and
   * the half it drops is the oldest — which is exactly where the overdue items are. */
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

  /* What changed since the last run, high up — the rest of this is the same list it
   * was, and a reader who already knows that will not scan it again. */
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

  /* Only worth having when the list is long enough that you cannot scan it. Below
   * that the full list is already the short list, and printing both is just saying
   * everything twice. */
  var cap = b.actionList === undefined ? 5 : b.actionList;
  if (cap && open.length > 8) {
    var moves = actionList(open, cap);
    p('DO THESE FIRST — one move each, most pressing first');
    moves.forEach(function (l) {
      // Numbered from the full list below, not renumbered — so replying "4" to reject
      // something means the same thing wherever you read it.
      p('  ' + (l.n < 10 ? ' ' : '') + l.n + '. ' + pad('[' + when(l) + ']', 12) + ' ' +
        shortenBody(move(l), 62));
      // Only where a note is the move. Paste it, send it, and the next run sees the
      // message and closes the loop without anyone ticking anything.
      var note = draft(l);
      if (note) p('        → ' + note);
    });
    p('  …and ' + (open.length - moves.length) + ' more below.');
    p('');
  }

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

  var many = (b.principals || []).length > 1;
  /* How many of each pile to actually print.
   *
   * Slack refuses a message over 4,000 characters, and a real mailbox goes far past
   * that: three Enron mailboxes rendered at 14,000, 29,000 and 29,000 characters — the
   * digest would not have been shortened, it would have failed to send, on somebody's
   * first day, with the runner correctly refusing to post half of one.
   *
   * It never showed up here because a test workspace produces eight items and 2,500
   * characters, and always has. Nothing about the list was wrong; it just had no
   * ceiling and had never met a mailbox with a real amount in it.
   *
   * The items are already risk-ordered and the ordering is already trusted — it is what
   * DO THESE FIRST selects on. So this takes the top of each pile and says out loud
   * what it held back. Saying so is not decoration: a list that quietly stops is
   * indistinguishable from a quiet week, which is the failure this whole thing exists
   * to prevent. */
  /* Off unless asked. The 4,000-character ceiling belongs to Slack, so the fitting is
   * the Slack runner's job — a renderer that silently truncates by default would hide
   * items from every other caller too, including the tests that check it shows all of
   * them. Passing 0 or nothing prints everything. */
  var perPile = b.listCap === undefined ? 0 : b.listCap;
  OWNER_ORDER.forEach(function (key) {
    var items = open.filter(function (l) { return l.owner === key; });
    if (!items.length) return;
    p(ownerTitle(key, b.principals).toUpperCase() + ' (' + items.length + ') — ' + OWNER[key].note);
    var held = perPile ? items.length - perPile : 0;
    (perPile ? items.slice(0, perPile) : items).forEach(function (l) {
      var when = !l.due ? 'no date'
        : l.status === 'overdue' ? l.overdueDays + 'd late'
        : l.status === 'due_today' ? 'today' : 'due ' + l.due;
      // The number is what you quote back to reject it, so it leads the line.
      var num = l.n ? (l.n < 10 ? ' ' + l.n : '' + l.n) + '. ' : '  ';
      p(num + '[' + when + '] ' + l.what);
      // How long this has been sitting here is its own kind of overdue.
      var tracked = l.isNew ? 'NEW' : l.trackedDays > 0 ? l.trackedDays + 'd on the list' : null;
      // With several principals the heading cannot name one, so each item does.
      var whose = many && l.principal ? 'for ' + l.principal.label + ' · ' : '';
      /* A channel you are alone in has no counterparty, and printing "undefined"
       * where a name goes is how a digest stops looking like it was written on
       * purpose. Say the conversation instead. */
      p('      ' + (tracked ? tracked + ' · ' : '') + whose +
        (l.rel ? l.rel.label + ' · ' : '') + (l.who ? l.who + ' · ' : '') + l.subject);
      if (l.weekendShift) p('      note: stated ' + l.due + ' is a weekend — last working day is ' + l.workDue);
      /* Late by the letter, normal for them. Chasing here is the thing that makes an
       * assistant look careless to the people it matters most with. */
      if (l.earlyForThem) {
        p('      note: they usually take ' + l.usualDays + 'd — ' + l.ageDays +
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

  if (r.closed.length) {
    p('CLOSED ITSELF (' + r.closed.length + ')');
    // Bounded by the same knob as the piles: on a busy mailbox this ran to ten entries
    // and 700 characters of good news, which is the cheapest thing to shorten.
    r.closed.slice(0, perPile || 10).forEach(function (l) { p('  ' + l.closedOn + '  ' + l.what); });
    p('');
  }

  p('Drafts only — nothing here has been sent. Verify before acting on any of it.');
  p('');
  p("Anything here that isn't real? Reply with just its number — \"3 7\" — and those");
  p('stop coming back. That reply is the only record of what this gets wrong.');
  p('Already knew about one? Put it on a line starting with k — "k 1 4". It stays on');
  p('the list; it just stops counting as something this told you.');

  /* The only question in here that can say anything about what was missed. Everything
   * else asks about things that appeared, and a miss produces nothing to reject. */
  if (b.spotCheck && b.spotCheck.length) {
    p('');
    p('SPOT CHECK — it found nothing in these. Did it miss something?');
    b.spotCheck.forEach(function (m, i) {
      p('  ' + String.fromCharCode(97 + i) + ') ' + shortenBody(m.body) +
        '      — ' + (m.subject || ''));
    });
    p('Reply "miss b d" for any that did contain a commitment, or "miss" on its own');
    p('if none did. Saying none is what makes the rest of it evidence.');
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
