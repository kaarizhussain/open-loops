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
  if (read.capped) {
    p('INCOMPLETE — stopped at the ' + (read.cap || 'read') + ' limit. The oldest of it was ' +
      'not read, which is where overdue items live. Narrow the window and rerun.');
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
  OWNER_ORDER.forEach(function (key) {
    var items = open.filter(function (l) { return l.owner === key; });
    if (!items.length) return;
    p(ownerTitle(key, b.principals).toUpperCase() + ' (' + items.length + ') — ' + OWNER[key].note);
    items.forEach(function (l) {
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
    });
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
    r.closed.slice(0, 10).forEach(function (l) { p('  ' + l.closedOn + '  ' + l.what); });
    p('');
  }

  p('Drafts only — nothing here has been sent. Verify before acting on any of it.');
  p('');
  p("Anything here that isn't real? Reply with just its number — \"3 7\" — and those");
  p('stop coming back. That reply is the only record of what this gets wrong.');
  p('Already knew about one? Put it on a line starting with k — "k 1 4". It stays on');
  p('the list; it just stops counting as something this told you.');
  if (b.ledgerUrl) p('Ledger: ' + b.ledgerUrl);
  return L.join('\n');
}

if (typeof module !== 'undefined') {
  module.exports = { render: render, headline: headline, digestOrder: digestOrder, ownerTitle: ownerTitle,
                     OWNER_ORDER: OWNER_ORDER };
}
