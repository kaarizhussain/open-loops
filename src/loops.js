/* Open Loops — commitment tracking for an executive assistant.
 *
 * Input shape (what a Gmail / Calendar adapter must produce):
 *   message: {id, threadId, subject, from, to[], date:'YYYY-MM-DDTHH:MM', body, attach:bool}
 *   event:   {id, title, start:'YYYY-MM-DDTHH:MM', attendees[], agenda:bool}
 * Direction is derived from `from` vs opts.exec, so no adapter has to label it.
 */

var DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
var MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

function day(s) { return s.slice(0, 10); }
function toUTC(s) { return new Date(day(s) + 'T00:00:00Z'); }
function iso(d) { return d.toISOString().slice(0, 10); }
function daysBetween(a, b) { return Math.round((toUTC(b) - toUTC(a)) / 86400000); }
function addDays(s, n) { var d = toUTC(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); }
function domain(addr) { return (addr.split('@')[1] || '').toLowerCase(); }

/* A deadline landing on a weekend is really a Friday deadline — nobody is reading it
 * Saturday, so the last working chance is the Friday before. */
function workingDue(s) {
  var d = toUTC(s), dow = d.getUTCDay();
  if (dow === 6) d.setUTCDate(d.getUTCDate() - 1);
  else if (dow === 0) d.setUTCDate(d.getUTCDate() - 2);
  else return s;
  return iso(d);
}

/* Next occurrence of a weekday strictly after `from` (same-day "by Friday" means next Friday). */
function nextDow(from, target) {
  var d = toUTC(from), cur = d.getUTCDay(), delta = (target - cur + 7) % 7;
  if (delta === 0) delta = 7;
  d.setUTCDate(d.getUTCDate() + delta);
  return iso(d);
}

/* Deadline language -> ISO date, resolved relative to when the message was sent. */
function parseDue(text, from) {
  var t = text.toLowerCase();
  var m = t.match(/\b(?:by|before|on)?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/);
  if (m) {
    var d = toUTC(from);
    var cand = new Date(Date.UTC(d.getUTCFullYear(), MONTHS[m[1]], +m[2]));
    if (cand < d) cand = new Date(Date.UTC(d.getUTCFullYear() + 1, MONTHS[m[1]], +m[2]));
    return iso(cand);
  }
  if (/\btomorrow\b/.test(t)) return addDays(from, 1);
  if (/\btoday\b|\bthis afternoon\b|\bby eod\b(?!\s+\w+day)/.test(t)) return day(from);
  var nextWk = /\bnext week\b/.test(t);
  // Weekday needs no preposition — "send it Thursday EOD" is a deadline too.
  var dm = t.match(/\b(?:by|before|on|this)?\s*(?:eod\s+|end of day\s+)?(sun|mon|tues|tue|wednes|wed|thurs|thur|thu|fri|satur|sat)(?:day)?\b/);
  if (dm) {
    var idx = DOW.indexOf(dm[1].slice(0, 3));
    // "Tuesday next week" resolves a week later than a bare "Tuesday".
    if (idx >= 0) return nextDow(nextWk ? nextDow(from, 5) : from, idx);
  }
  if (nextWk) return nextDow(nextDow(from, 5), 5);
  if (/\bthis week\b|\bend of week\b|\beow\b/.test(t)) return nextDow(from, 5);
  return null;
}

/* "let me know" is an ask, not a promise — exclude it explicitly. */
var COMMIT = /\b(i'?ll|i will|we'?ll|we will|let me(?!\s+know)|i'?m going to|will (?:send|get|share|review|book|connect|loop|circle|have|put|pull|draft|forward))\b/i;
var DELIVER = /\b(attached|here'?s|here is|just sent|sent (?:it|you|over|through)|sending (?:it|over)|done|signed|uploaded|shared|forwarded|all set)\b/i;
var ASK = /\b(can you|could you|would you|please|need your|need you to|waiting on|any update|following up|checking in|let me know|confirm)\b/i;
/* An intro is an email, not a meeting — keep those as plain promises. */
var MEETINGY = /\b(call|meeting|sync|chat|conversation|walk (?:you|them) through)\b/i;
var SCHEDULEY = /\b(schedule|book|set up|find time|works|available|on the books|next week|this week)\b/i;
var STOPWORD = /^(the|and|for|with|from|call|meeting|sync|intro|next|steps|update|request|review|plan|reference)$/i;

/* Distinctive words from a subject line, used to spot a matching calendar hold. */
function keyTokens(subject) {
  return (subject.match(/\b[A-Z][A-Za-z]{3,}\b/g) || []).filter(function (w) { return !STOPWORD.test(w); });
}

/* Who takes the next action. An EA's list is really three lists: what I chase,
 * what I handle myself, and what only the executive can do. The split is by the
 * next action, not by who benefits — booking a call the exec will attend is
 * still the assistant's move. */
var EXEC_WORK = /\b(review|sign[- ]?off|approve|approval|decision|decide|feedback|pricing|redline|deck|section|reference call|weigh in)\b/i;
var EA_WORK = /\b(agenda|invite|calendar|schedul\w*|book|venue|recap|notes|questionnaire|bio|talk title|itinerary|travel|circulate|forward|logistics|intro\w*|connect)\b/i;

function assignOwner(type, what, subject) {
  if (type === 'owed_to_us' || type === 'awaiting_reply') return 'them';
  // These three are logistics by definition — the next move is always the assistant's.
  if (type === 'agreed_unscheduled' || type === 'no_followup' || type === 'unprepped_meeting') return 'you';
  var t = what + ' ' + subject;
  if (EXEC_WORK.test(t)) return 'exec';
  if (EA_WORK.test(t)) return 'you';
  return 'exec';
}

/* Relationship tiers. Every assistant weights a promise to the board differently
 * from one to a vendor; this is that judgment, written down. Keyed by address or
 * domain, curated by the assistant — not inferred. */
var TIER_WEIGHT = { investor: 26, exec: 22, key_account: 20, customer: 12, partner: 9, prospect: 8, internal: 4, other: 0 };

function relationship(addr, contacts) {
  if (!contacts) return null;
  var a = addr.toLowerCase();
  var hit = contacts[a] || contacts[domain(a)];
  if (!hit) return null;
  // `as` overrides the derived display name for role addresses like program@ or hr@.
  return { tier: hit.tier, label: hit.label, context: hit.context || null,
           as: hit.as || null, weight: TIER_WEIGHT[hit.tier] || 0 };
}

/* Does a delivery actually refer to this promise? Without this check a single
 * "pricing attached" quietly closes every other promise in the thread, and things
 * leave the list without being done — the worst failure this tool can have.
 * Matched on shared subject-matter words, prefixed to absorb simple plurals and
 * tenses. A delivery with no topical words of its own ("Attached.") can't be
 * discriminated, so it is allowed to close. */
var TOPIC_STOP = /^(the|and|for|you|your|our|their|its|will|would|can|could|should|have|has|had|been|are|was|were|that|this|these|those|with|from|into|over|back|also|some|more|need|want|get|got|give|take|make|send|sent|sending|attach|attached|here|there|just|then|than|when|what|which|who|how|why|about|before|after|once|soon|today|tomorrow|week|day|days|monday|tuesday|wednesday|thursday|friday|saturday|sunday|eod|latest|ahead|team|thanks|thank|please|sure|okay|yes|all|set|done|out|off|via|per|any|one|two|let|know|good|talking|apologies|delay)$/;

function topics(text) {
  var out = {};
  (String(text).toLowerCase().match(/[a-z0-9]{3,}/g) || []).forEach(function (w) {
    if (!TOPIC_STOP.test(w)) out[w.slice(0, 4)] = 1;
  });
  return out;
}
function refersTo(promise, delivery) {
  var d = topics(delivery), p = topics(promise);
  // "I'll send it Thursday EOD" names nothing; neither does a bare "Attached."
  // Either way there is nothing to discriminate on, so do not block the close.
  if (!Object.keys(d).length || !Object.keys(p).length) return true;
  return Object.keys(p).some(function (k) { return d[k]; });
}

function sentences(body) {
  return body.split(/(?<=[.!?])\s+|\n+/).map(function (s) { return s.trim(); }).filter(Boolean);
}
function shorten(s, n) {
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1).replace(/[,;:\s]+\S*$/, '') + '…' : s;
}

function detectLoops(messages, events, opts) {
  var exec = opts.exec.toLowerCase(), today = opts.today, execDomain = domain(exec);
  var out = [];
  var threads = {};
  messages.slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; })
    .forEach(function (m) {
      m.out = m.from.toLowerCase() === exec;
      (threads[m.threadId] = threads[m.threadId] || []).push(m);
    });

  Object.keys(threads).forEach(function (tid) {
    var msgs = threads[tid], last = msgs[msgs.length - 1];
    var counterparty = null;
    msgs.forEach(function (m) {
      if (!m.out && domain(m.from) !== execDomain && !counterparty) counterparty = m.from;
    });
    if (!counterparty) {
      msgs.forEach(function (m) {
        if (m.out) m.to.forEach(function (t) { if (!counterparty && t.toLowerCase() !== exec) counterparty = t; });
        else if (!counterparty) counterparty = m.from;
      });
    }

    /* --- promises, in both directions --- */
    msgs.forEach(function (m, i) {
      sentences(m.body).forEach(function (s) {
        if (!COMMIT.test(s)) return;
        /* No DELIVER check here, deliberately. A bare "attached" never reaches this
         * line — COMMIT already rejected it. The only sentences a DELIVER test could
         * reject are ones that commit *and* use delivery words, and those are promises:
         * "we’ll have the signed copy back Friday", "just sent it, I’ll follow up Monday".
         * Tense decides, not vocabulary, and a commitment is future tense by construction. */
        var later = msgs.slice(i + 1).filter(function (n) { return n.out === m.out; });
        var closer = null;
        later.forEach(function (n) {
          if (closer) return;
          if ((n.attach || DELIVER.test(n.body)) && refersTo(s, n.body)) closer = n;
        });
        // "I'll review before the deadline" — the date lives in the message being answered.
        var due = parseDue(s, m.date);
        for (var j = i - 1; j >= 0 && !due; j--) due = parseDue(msgs[j].body, msgs[j].date);
        var type = m.out ? 'owed_by_us' : 'owed_to_us';
        // The promise and the scheduling language often sit in different sentences.
        if (!closer && m.out && MEETINGY.test(s) && SCHEDULEY.test(m.body)) {
          var toks = keyTokens(m.subject);
          var booked = events.some(function (e) {
            if (e.start < day(m.date)) return false;
            // An internal colleague appears on unrelated meetings — their presence proves nothing.
            if (counterparty && domain(counterparty) !== execDomain && e.attendees.indexOf(counterparty) > -1) return true;
            return toks.some(function (w) { return e.title.toLowerCase().indexOf(w.toLowerCase()) > -1; });
          });
          if (!booked) type = 'agreed_unscheduled';
        }
        out.push({
          type: closer ? 'closed' : type, openType: type, threadId: tid, subject: m.subject,
          who: m.out ? (counterparty || m.to[0]) : m.from, byUs: m.out,
          what: shorten(s, 110), said: day(m.date), due: due,
          closedOn: closer ? day(closer.date) : null,
          closedBy: closer ? shorten(sentences(closer.body).find(function (x) { return DELIVER.test(x); }) || closer.body, 80) : null,
          excerpt: s, msgId: m.id
        });
      });
    });

    /* --- silence in either direction ---
     * Anchored on the last message we sent, not the last message in the thread. A
     * client who follows up must not erase their own earlier unanswered request —
     * the clock still runs from when they first asked. */
    var lastOut = -1, lastIn = -1;
    msgs.forEach(function (m, i) { if (m.out) lastOut = i; else lastIn = i; });
    var askIn = function (m) {
      return sentences(m.body).filter(function (s) { return ASK.test(s) || /\?$/.test(s); })[0];
    };

    if (lastIn > lastOut) {
      // They are waiting on us. Age from the oldest thing still unanswered.
      var pending = msgs.slice(lastOut + 1).filter(function (m) { return !m.out && askIn(m); });
      if (pending.length) {
        var first = pending[0], fAge = daysBetween(day(first.date), today);
        if (fAge >= 2) {
          var fs = askIn(first);
          out.push({
            type: 'unanswered_ask', threadId: tid, subject: first.subject,
            who: first.from, byUs: true, pendingCount: pending.length,
            what: shorten(fs, 110), said: day(first.date), age: fAge,
            due: parseDue(fs, first.date), excerpt: first.body, msgId: first.id
          });
        }
      }
    } else if (lastOut > -1 && askIn(msgs[lastOut])) {
      // We are waiting on them.
      var ours = msgs[lastOut], oAge = daysBetween(day(ours.date), today);
      if (oAge >= 2) {
        out.push({
          type: 'awaiting_reply', threadId: tid, subject: ours.subject,
          who: counterparty || ours.to[0], byUs: false,
          what: shorten(askIn(ours), 110), said: day(ours.date), age: oAge,
          // A date in an outbound question is a proposed slot, not a deadline.
          due: null, excerpt: ours.body, msgId: ours.id
        });
      }
    }
  });

  /* --- meetings: no follow-up after, no agenda before --- */
  events.forEach(function (e) {
    var ext = e.attendees.filter(function (a) { return domain(a) !== execDomain; });
    if (!ext.length) return;
    var when = day(e.start);
    if (when < today) {
      var followed = messages.some(function (m) {
        return m.from.toLowerCase() === exec && day(m.date) >= when &&
          m.to.some(function (t) { return ext.indexOf(t) > -1; });
      });
      if (!followed && daysBetween(when, today) >= 1) {
        out.push({ type: 'no_followup', threadId: null, subject: e.title, who: ext[0], byUs: true,
          what: 'No recap or next steps sent after the meeting', said: when, due: null, eventId: e.id });
      }
    } else if (!e.agenda && daysBetween(today, when) <= 2) {
      out.push({ type: 'unprepped_meeting', threadId: null, subject: e.title, who: ext[0], byUs: true,
        what: 'No agenda attached', said: today, due: when, eventId: e.id, start: e.start });
    }
  });

  /* --- status + risk --- */
  out.forEach(function (l) {
    if (l.type === 'closed') { l.status = 'closed'; l.risk = 0; return; }
    // Everything downstream reasons about the last working chance, not the stated date.
    l.workDue = l.due ? workingDue(l.due) : null;
    l.weekendShift = !!(l.due && l.workDue !== l.due);
    var over = l.workDue ? daysBetween(l.workDue, today) : null;
    l.overdueDays = over > 0 ? over : 0;
    l.ageDays = l.age != null ? l.age : daysBetween(l.said, today);
    if (over > 0) l.status = 'overdue';
    else if (over === 0) l.status = 'due_today';
    else if (over != null && over >= -2) l.status = 'due_soon';
    else l.status = 'open';

    var r = { owed_by_us: 45, agreed_unscheduled: 40, unanswered_ask: 35, owed_to_us: 30,
              unprepped_meeting: 40, no_followup: 25, awaiting_reply: 20 }[l.type] || 20;
    if (l.status === 'overdue') r += 45 + Math.min(l.overdueDays, 10) * 4;
    else if (l.status === 'due_today') r += 40;
    else if (l.status === 'due_soon') r += 22;
    else r += Math.min(l.ageDays, 14) * 2;
    if (l.type === 'unprepped_meeting' && l.due === today) r += 20;

    l.owner = assignOwner(l.type, l.what, l.subject);
    l.rel = relationship(l.who, opts.contacts);
    if (l.rel) r += l.rel.weight;
    l.risk = r;
  });

  var open = out.filter(function (l) { return l.type !== 'closed'; })
    .sort(function (a, b) { return b.risk - a.risk; });
  var closed = out.filter(function (l) { return l.type === 'closed'; })
    .sort(function (a, b) { return a.closedOn < b.closedOn ? 1 : -1; });
  return { open: open, closed: closed, today: today };
}

/* Regroup everything by upcoming meeting. The list answers "what is outstanding";
 * an assistant is asked "what do I need before this". Same commitments, read the
 * way you read them the night before. */
function meetingBriefs(messages, events, open, opts) {
  var today = opts.today, execDomain = domain(opts.exec.toLowerCase());
  return events.map(function (e) {
    if (day(e.start) < today) return null;
    var ext = e.attendees.filter(function (a) { return domain(a) !== execDomain; });
    if (!ext.length) return null;
    var doms = ext.map(domain);
    var items = open.filter(function (l) {
      if (l.eventId === e.id) return false;         // the agenda flag already says this
      return l.who && (ext.indexOf(l.who) > -1 || doms.indexOf(domain(l.who)) > -1);
    }).sort(function (a, b) { return b.risk - a.risk; });
    var last = null;
    messages.forEach(function (m) {
      var party = m.from.toLowerCase() === opts.exec.toLowerCase() ? m.to : [m.from];
      if (party.some(function (p) { return doms.indexOf(domain(p)) > -1; })) {
        if (!last || m.date > last) last = m.date;
      }
    });
    // An agenda that arrives on the morning of is too late to prep against.
    var prepBy = addDays(day(e.start), -1);
    return {
      id: e.id, title: e.title, start: e.start, day: day(e.start),
      inDays: daysBetween(today, day(e.start)),
      attendees: ext, agenda: e.agenda, items: items,
      lastContact: last ? day(last) : null,
      prepBy: prepBy,
      prepDue: !e.agenda && prepBy <= today,      // runway closes today or has already gone
      prepLate: !e.agenda && prepBy < today,
      ready: e.agenda && !items.length
    };
  }).filter(Boolean).sort(function (a, b) { return a.start < b.start ? -1 : 1; });
}

/* A stable identity for a detected item, so that re-running against a longer message
 * set keeps what the assistant already did to it — and so anything genuinely new can
 * be told apart from everything that was already on the list. */
function loopKey(l) {
  if (l.eventId) return l.type + '|' + l.eventId;
  return [l.type, l.threadId, l.said, l.what].join('|');
}

var OWNER = {
  them: { title: 'Chase them', note: 'Someone else owes this. Your move is the nudge.' },
  you:  { title: 'Yours to handle', note: 'Logistics you can close out without the executive.' },
  exec: { title: 'Needs the executive', note: 'Only they can produce or decide this — protect the time for it.' }
};

var LABEL = {
  owed_by_us: 'You promised',
  owed_to_us: 'They promised',
  unanswered_ask: 'Unanswered',
  awaiting_reply: 'No reply yet',
  agreed_unscheduled: 'Agreed, not booked',
  no_followup: 'No follow-up sent',
  unprepped_meeting: 'Meeting unprepped'
};

if (typeof module !== 'undefined') module.exports = {
  detectLoops: detectLoops, meetingBriefs: meetingBriefs, loopKey: loopKey,
  parseDue: parseDue, LABEL: LABEL, OWNER: OWNER, TIER_WEIGHT: TIER_WEIGHT
};
