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

/* Which side of the table somebody sits on.
 *
 * `domain()` was quietly doing two jobs: reading an address's host, and standing in
 * for "same organisation". The second reading only holds when the domain IS an
 * organisation. On gmail.com it says every Gmail user in the world is your colleague,
 * which switched both calendar signals off silently — and, worse, stopped a calendar
 * hold from closing a promise, because the person on the invite read as internal and
 * their presence therefore "proved nothing". A booked call that can never close is
 * the un-clearable item this whole tool is supposed to prevent.
 *
 * A real company domain identifies a side. A shared host does not, and on one of
 * those the only person on your side is you. On a corporate address this returns
 * exactly what domain() returned, so that path does not change at all.
 *
 * An exact table rather than a pattern, because a pattern over these names also
 * matches outlook.ai, aol.xyz and msn.dev — which are somebody's employer, and whose
 * staff would have every colleague reclassified as an outsider. */
var SHARED = {
  'gmail.com': 1, 'googlemail.com': 1, 'yahoo.com': 1, 'yahoo.co.uk': 1, 'ymail.com': 1,
  'rocketmail.com': 1, 'hotmail.com': 1, 'hotmail.co.uk': 1, 'outlook.com': 1,
  'live.com': 1, 'msn.com': 1, 'aol.com': 1, 'icloud.com': 1, 'me.com': 1, 'mac.com': 1,
  'gmx.com': 1, 'gmx.de': 1, 'web.de': 1, 'proton.me': 1, 'protonmail.com': 1,
  'fastmail.com': 1, 'tutanota.com': 1, 'zoho.com': 1, 'yandex.com': 1, 'yandex.ru': 1,
  'mail.com': 1, 'mail.ru': 1, 'qq.com': 1, '163.com': 1, 'naver.com': 1,
  'hanmail.net': 1, 'daum.net': 1,
  /* slack.js mints this for anyone whose profile carried no address. Two of them are
     not colleagues — they are two strangers who both lack an address. */
  'slack.local': 1
};

function side(addr) {
  var a = String(addr || '').toLowerCase().trim();
  var at = a.lastIndexOf('@');
  if (at < 0) return a;
  var host = a.slice(at + 1);
  if (!SHARED[host]) return host;
  // Shared host, so the address is the identity. Plus-tags are the same person.
  return a.slice(0, at).split('+')[0] + '@' + host;
}

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
  /* The ordinal suffix is optional but must be allowed to be there. Requiring a word
   * boundary straight after the digits meant "Aug 15th" and "Sept 3rd" — much commoner
   * than the bare form — matched nothing at all and silently arrived undated. */
  var m = t.match(/\b(?:by|before|on)?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (m) {
    var d = toUTC(from);
    var cand = new Date(Date.UTC(d.getUTCFullYear(), MONTHS[m[1]], +m[2]));
    if (cand < d) cand = new Date(Date.UTC(d.getUTCFullYear() + 1, MONTHS[m[1]], +m[2]));
    return iso(cand);
  }

  /* "by the 15th" — a day with no month, meaning the next one to come round.
   *
   * The ordinal suffix is required here rather than optional: it is the only thing
   * separating a date from a quantity, and "by the 15 remaining" must never become a
   * deadline. The lookahead covers the ordinals that are not dates at all — a third
   * floor, a second opinion, a fourth quarter. */
  var om = t.match(/\b(?:by|before|due|on)\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b(?!\s+(?:floor|option|attempt|try|round|quarter|place|party|opinion|version|draft|time))/);
  if (om) {
    var dom = +om[1], base = toUTC(from);
    if (dom >= 1 && dom <= 31) {
      var next = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), dom));
      // Already gone this month, so they mean next month's.
      if (next < base) next = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, dom));
      return iso(next);
    }
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

/* "let me know" is an ask, not a promise — exclude it explicitly.
 *
 * "let's" is allow-listed against verbs rather than opened up, because most of its uses
 * are discourse: let's see, let's be honest, let's not get ahead of ourselves. What
 * survives is the scheduling sense — "let's set up a call Thursday" is an agreement
 * somebody now has to act on, and it was going undetected entirely. Chat leans on it
 * far more than mail does, which is why it surfaced only once this read real Slack. */
/* "have to" and "need to" after a modal is an obligation somebody is under, not a
 * commitment somebody made. "We will have to go through that again" and "each person
 * will have to move their data over" are both descriptions of a constraint, and both
 * were being read as promises — two of the commonest false positives in 3,700 real
 * emails, and invisible in a fixture because nobody writes that sentence on purpose.
 *
 * Excluded per-modal rather than by dropping `have`, because "I will have it to you
 * Friday" is a genuine promise and has to keep matching.
 *
 * Only "have to". "Need to" was in here briefly on a hunch and came straight back out
 * when it silently stopped detecting "we'll need to redo the onboarding docs" — the
 * corpus showed "will have to", not "will need to", and "I'll need to check with legal"
 * is a soft commitment rather than an obligation. Fix what the data showed. */
/* Both apostrophes, because half the world types the curly one without choosing to.
 * macOS and iOS substitute ' for ' system-wide by default, and anything pasted out of
 * Word, Docs or Notes carries it. Matching only the straight one meant "I'll send the
 * deck Thursday" was a commitment and "I’ll send the deck Thursday" was nothing —
 * every contraction here, silently, with no error and nothing to reject.
 *
 * That is the worst shape of bug this can have: a false negative is invisible to the
 * correction loop, which only ever learns from things it showed you. The Enron corpus
 * cannot measure it either — 0 of 8,716 messages contain a curly apostrophe, because
 * 2001 mail was plain text. A benchmark being silent is not the same as a problem
 * being absent. */
var FIRM = /\b(?:(?:i['’]?ll|i will|we['’]?ll|we will|i['’]?m going to)(?!\s+have\s+to\b)|let me(?!\s+know)|will (?:send|get|share|review|book|connect|loop|circle|have(?!\s+to\b)|put|pull|draft|forward))\b/i;
var LETS = /\b(let['’]?s (?:schedule|book|set up|find time|meet|sync|talk|discuss|catch up|go over|walk through))\b/i;
var COMMIT = new RegExp(FIRM.source + '|' + LETS.source, 'i');
var DELIVER = /\b(attached|here['’]?s|here is|just sent|sent (?:it|you|over|through)|sending (?:it|over)|done|signed|uploaded|shared|forwarded|all set)\b/i;
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

function assignOwner(type, what, subject, solo) {
  if (type === 'owed_to_us' || type === 'awaiting_reply') return 'them';
  // These three are logistics by definition — the next move is always the assistant's.
  if (type === 'agreed_unscheduled' || type === 'no_followup' || type === 'unprepped_meeting') return 'you';
  /* Supporting nobody collapses two of the three piles into one. Splitting work into
   * "yours" and "the executive's" when you are the executive produces a heading that
   * lies about its own contents. */
  if (solo) return 'you';
  var t = what + ' ' + subject;
  if (EXEC_WORK.test(t)) return 'exec';
  if (EA_WORK.test(t)) return 'you';
  return 'exec';
}

/* Who this belongs to, when the reader supports more than one person.
 *
 * One deployment usually reads one mailbox, so the list is usually empty or a single
 * name. It genuinely holds several only when someone runs this over their own
 * account and is copied on several people's work — which is also the version that
 * needs nobody's permission to set up. */
function principalFor(parties, principals) {
  if (!principals || !principals.length) return null;
  if (principals.length === 1) return principals[0];
  var on = principals.filter(function (p) {
    return p.address && (parties || []).indexOf(String(p.address).toLowerCase()) > -1;
  });
  // Nobody identifiable on the conversation — better to name the likeliest than to
  // drop the item into an unlabelled pile.
  return on[0] || principals[0];
}

/* Relationship tiers. Every assistant weights a promise to the board differently
 * from one to a vendor; this is that judgment, written down. Keyed by address or
 * domain, curated by the assistant — not inferred. */
var TIER_WEIGHT = { investor: 26, exec: 22, key_account: 20, customer: 12, partner: 9, prospect: 8, internal: 4, other: 0 };

function relationship(addr, contacts) {
  if (!contacts) return null;
  var a = String(addr || '').toLowerCase();
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
/* Three answers, not two:
 *
 *   true  — they share subject-matter words
 *   false — both name something, and they name different things
 *   null  — one of them names nothing, so this cannot tell you either way
 *
 * The third is the dangerous one, and it used to be reported as a match. "Attached."
 * names nothing; so does "I'll send it Thursday EOD". Treating that as agreement is
 * how one attachment quietly closes every open promise in a conversation — things
 * leave the list without being done, which is the worst failure this can have.
 * The caller resolves it with the only other evidence there is: whether there was
 * anything else the delivery could have been answering. */
function topicMatch(promise, delivery) {
  var d = topics(delivery), p = topics(promise);
  if (!Object.keys(d).length || !Object.keys(p).length) return null;
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
  var exec = opts.exec.toLowerCase(), today = opts.today, execSide = side(exec);
  /* Who the reader supports. Absent means the historical shape — one unnamed
   * executive — so nothing that does not pass this changes behaviour. An explicit
   * empty list means they support nobody and are running it on their own work. */
  var principals = opts.principals;
  var solo = Array.isArray(principals) && principals.length === 0;
  var out = [];
  var threads = {};
  /* Equal timestamps must compare equal, or the sort is free to reorder them.
   * Mail rarely collides to the minute; chat does it constantly, and the caller has
   * already put them in the right order. */
  messages.slice().sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; })
    .forEach(function (m) {
      m.out = m.from.toLowerCase() === exec;
      (threads[m.threadId] = threads[m.threadId] || []).push(m);
    });

  Object.keys(threads).forEach(function (tid) {
    var msgs = threads[tid], last = msgs[msgs.length - 1];
    /* Everyone on this conversation, so an item can be routed to whichever principal
     * was actually party to it. Only consulted when there is more than one. */
    var seen = {};
    msgs.forEach(function (m) {
      seen[m.from.toLowerCase()] = 1;
      (m.to || []).forEach(function (t) { seen[String(t).toLowerCase()] = 1; });
    });
    var parties = Object.keys(seen);
    var mark = out.length;
    var counterparty = null;
    msgs.forEach(function (m) {
      if (!m.out && side(m.from) !== execSide && !counterparty) counterparty = m.from;
    });
    if (!counterparty) {
      msgs.forEach(function (m) {
        if (m.out) (m.to || []).forEach(function (t) { if (!counterparty && String(t).toLowerCase() !== exec) counterparty = t; });
        else if (!counterparty) counterparty = m.from;
      });
    }

    /* --- promises, in both directions ---
     *
     * Collected first, then deliveries resolved against them in order. Letting each
     * promise scan forward for its own closer cannot answer "was this the only thing
     * outstanding when that delivery arrived" — and that is the only evidence there
     * is when a delivery names nothing. */
    var promises = [];
    msgs.forEach(function (m, i) {
      var firm = false;
      sentences(m.body).forEach(function (s) {
        /* "Sure — I'll do the call. Tuesday works, let's find time." is one agreement
         * said twice, and listing it twice is the noise this cares most about. A
         * "let's" after your own commitment in the same message is elaboration; a
         * genuinely separate second commitment says "I'll" again. */
        if (firm && !FIRM.test(s)) return;
        if (FIRM.test(s)) firm = true;
        /* No DELIVER check here, deliberately. A bare "attached" never reaches this
         * line — COMMIT already rejected it. The only sentences a DELIVER test could
         * reject are ones that commit *and* use delivery words, and those are promises:
         * "we’ll have the signed copy back Friday", "just sent it, I’ll follow up Monday".
         * Tense decides, not vocabulary, and a commitment is future tense by construction. */
        if (COMMIT.test(s)) promises.push({ at: i, m: m, s: s, closer: null });
      });
    });

    msgs.forEach(function (n, j) {
      /* The delivery sentence is the evidence, not the whole message — otherwise
       * "the NDA is signed, still working on the pricing" closes the pricing promise
       * on the strength of one word about something else. An attachment has no
       * sentence of its own, so there the message body is all the evidence there is. */
      var evidence = n.attach ? [n.body]
        : sentences(n.body).filter(function (x) { return DELIVER.test(x); });

      evidence.forEach(function (d) {
        // Recomputed per sentence: two deliveries in one message close in sequence.
        var open = promises.filter(function (p) {
          return !p.closer && p.m.out === n.out && p.at < j;
        });
        if (!open.length) return;

        // "Pricing and the questionnaire attached" legitimately closes two things.
        var named = open.filter(function (p) { return topicMatch(p.s, d) === true; });
        if (named.length) { named.forEach(function (p) { p.closer = n; }); return; }

        /* Neither side names anything, so there is nothing to match on. Closing is
         * only safe when exactly one promise was outstanding — then "Attached." can
         * only have meant that one. With two open it could have meant either, and
         * guessing closes something that was never done. */
        if (open.length === 1 && topicMatch(open[0].s, d) === null) open[0].closer = n;
      });
    });

    promises.forEach(function (pr) {
      var m = pr.m, i = pr.at, s = pr.s, closer = pr.closer;
      /* "I'll review and get back to you before the deadline" carries no date — it was
       * in the message being answered. So walk back for it, but only into messages
       * from the other side.
       *
       * A deadline you inherit is one somebody else set and you agreed to. Your own
       * earlier messages did not set it, and letting a promise borrow a date from
       * another thing you happened to say is how "I'll have the numbers over by the
       * 15th" ends up due tomorrow, because tomorrow appeared in an unrelated
       * sentence further up. Harmless in mail, where a thread is one subject.
       * Not harmless in chat, where the thread is an entire channel. */
      var due = parseDue(s, m.date);
      for (var k = i - 1; k >= 0 && !due; k--) {
        if (msgs[k].out === m.out) continue;
        due = parseDue(msgs[k].body, msgs[k].date);
      }
      var type = m.out ? 'owed_by_us' : 'owed_to_us', bookedBy = null;
      // The promise and the scheduling language often sit in different sentences.
      if (!closer && m.out && MEETINGY.test(s) && SCHEDULEY.test(m.body)) {
        var toks = keyTokens(m.subject);
        bookedBy = events.filter(function (e) {
          if (e.start < day(m.date)) return false;
          // An internal colleague appears on unrelated meetings — their presence proves nothing.
          if (counterparty && side(counterparty) !== execSide && e.attendees.indexOf(counterparty) > -1) return true;
          return toks.some(function (w) { return e.title.toLowerCase().indexOf(w.toLowerCase()) > -1; });
        })[0];
        /* A promise to get something in the diary is kept by the thing being in the
         * diary. Reclassifying it and leaving it open — which is what this used to do —
         * meant the hold settled the question and the item nagged anyway. This only
         * applies to promises that were about scheduling in the first place, which is
         * what the MEETINGY and SCHEDULEY gate above establishes. */
        if (!bookedBy) type = 'agreed_unscheduled';
      }
      out.push({
        type: (closer || bookedBy) ? 'closed' : type, openType: type, threadId: tid,
        subject: m.subject,
        who: m.out ? (counterparty || m.to[0]) : m.from, byUs: m.out,
        what: shorten(s, 110), said: day(m.date), due: due,
        closedOn: closer ? day(closer.date) : bookedBy ? day(bookedBy.start) : null,
        closedBy: closer
          ? shorten(sentences(closer.body).find(function (x) { return DELIVER.test(x); }) || closer.body, 80)
          : bookedBy ? 'In the diary: ' + shorten(bookedBy.title, 60) : null,
        excerpt: s, msgId: m.id
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
    } else if (lastOut > -1) {
      /* We are waiting on them. The oldest ask still unanswered, not the most recent
       * message — our own later messages must not bury our own earlier question, for
       * the same reason theirs do not bury theirs. Asking on Monday and saying
       * something unrelated on Tuesday is how a question goes quiet, not how it
       * gets answered. */
      var waiting = msgs.slice(lastIn + 1).filter(function (m) { return m.out && askIn(m); });
      var ours = waiting[0], oAge = ours && daysBetween(day(ours.date), today);
      if (ours && oAge >= 2) {
        out.push({
          type: 'awaiting_reply', threadId: tid, subject: ours.subject,
          who: counterparty || ours.to[0], byUs: false,
          what: shorten(askIn(ours), 110), said: day(ours.date), age: oAge,
          // A date in an outbound question is a proposed slot, not a deadline.
          due: null, excerpt: ours.body, msgId: ours.id
        });
      }
    }

    // Everything this thread produced carries the thread's participants with it.
    for (var q = mark; q < out.length; q++) out[q].parties = parties;
  });

  /* --- meetings: no follow-up after, no agenda before ---
   *
   * no_followup asks whether a recap went out, and the only evidence it has is an
   * outbound message addressed to somebody who was at the meeting. `to` means two
   * different things depending on where the messages came from: in mail it is the
   * delivery list, which answers the question; in Slack it is the channel roster,
   * which does not — and outside guests are not in your workspace, so the test can
   * only ever come back false. Every past external meeting then fires forever with
   * nothing able to clear it, and it fires even when a recap was posted.
   *
   * So the detector stops assuming and checks once, against the corpus it was handed:
   * has ANY outbound message ever been addressed to an external attendee of a meeting
   * we actually read? If not, `to` is not a delivery list here and the signal has no
   * evidence to reason about — so it goes dark and the digest says so, rather than
   * inventing an absence out of a field that was never going to answer.
   *
   * Corpus-wide rather than per-meeting, deliberately: per-meeting would silence the
   * mail case this signal was written for, where meeting somebody new and never
   * writing to them is the most valuable thing it finds. */
  /* Whether a missing agenda on this event is worth saying out loud.
   *
   * A standing meeting whose body is empty every week is not seven hundred oversights,
   * it is how that meeting is run. Firing on each occurrence made an item that printed
   * NEW every week — loopKey is type|eventId and Google gives every occurrence its own
   * id — which no rejection could clear, because rejecting one instance clears exactly
   * that instance, and muting matches on the item's text, which is the same literal
   * 'No agenda attached' on every unprepped meeting in the workspace. The only place
   * this can be stopped is here.
   *
   * So a series has to earn the nag: if any occurrence in the window carried an agenda,
   * this is a meeting that normally gets one and a blank week is worth flagging. If none
   * ever did, stay quiet and report the count instead. One occurrence is enough to arm
   * it, not two — a fortnight's fetch holds two or three occurrences of a weekly series,
   * so a higher bar would disarm on the second missed week, which is the week that
   * matters, and would leave a fortnightly series unarmable for good.
   *
   * ponytail: arming lives only inside the calendar window, so a monthly or quarterly
   * series can never arm from its own history — persist a marker in the ledger if that
   * starts mattering. */
  var armed = {};
  events.forEach(function (e) { if (e.series && e.agenda) armed[e.series] = 1; });
  var agendaWatched = function (e) { return !e.series || !!armed[e.series]; };
  var quietSeries = 0;

  var invited = {};
  events.forEach(function (e) {
    e.attendees.forEach(function (a) {
      if (side(a) !== execSide) invited[String(a).toLowerCase()] = 1;
    });
  });
  var canSeeFollowup = messages.some(function (m) {
    return m.from.toLowerCase() === exec &&
      (m.to || []).some(function (t) { return invited[String(t).toLowerCase()]; });
  });
  var darkFollowup = 0;

  events.forEach(function (e) {
    var ext = e.attendees.filter(function (a) { return side(a) !== execSide; });
    if (!ext.length) return;
    var when = day(e.start);
    if (when < today) {
      if (!canSeeFollowup) {
        if (daysBetween(when, today) >= 1) darkFollowup++;
        return;
      }
      var followed = messages.some(function (m) {
        return m.from.toLowerCase() === exec && day(m.date) >= when &&
          (m.to || []).some(function (t) { return ext.indexOf(String(t).toLowerCase()) > -1; });
      });
      if (!followed && daysBetween(when, today) >= 1) {
        out.push({ type: 'no_followup', threadId: null, subject: e.title, who: ext[0], byUs: true,
          what: 'No recap or next steps sent after the meeting', said: when, due: null, eventId: e.id });
      }
    } else if (!e.agenda && daysBetween(today, when) <= 2) {
      if (!agendaWatched(e)) { quietSeries++; return; }
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

    /* How long this person actually takes, learned from what they have delivered
     * before. Somebody who always takes ten days is not behaving badly on day three,
     * whatever they said — and chasing someone who is behaving completely normally
     * costs credibility with exactly the people the tiers say matter most.
     *
     * It damps the urgency, never the fact. They said Friday and it is Tuesday, so
     * the item stays overdue and stays on the list; what waits is the escalation that
     * would push it to the top and put it in front of you as a chase. */
    var pace = (opts.tempo || {})[String(l.who || '').toLowerCase()];
    l.usualDays = pace || null;
    l.earlyForThem = !!(pace && l.status === 'overdue' && l.ageDays < pace);

    var r = { owed_by_us: 45, agreed_unscheduled: 40, unanswered_ask: 35, owed_to_us: 30,
              unprepped_meeting: 40, no_followup: 25, awaiting_reply: 20 }[l.type] || 20;
    if (l.status === 'overdue') r += l.earlyForThem ? 10 : 45 + Math.min(l.overdueDays, 10) * 4;
    else if (l.status === 'due_today') r += 40;
    else if (l.status === 'due_soon') r += 22;
    else r += Math.min(l.ageDays, 14) * 2;
    if (l.type === 'unprepped_meeting' && l.due === today) r += 20;

    l.owner = assignOwner(l.type, l.what, l.subject, solo);
    l.principal = l.owner === 'exec' ? principalFor(l.parties, principals) : null;
    l.rel = relationship(l.who, opts.contacts);
    if (l.rel) r += l.rel.weight;
    l.risk = r;
  });

  var open = out.filter(function (l) { return l.type !== 'closed'; })
    .sort(function (a, b) { return b.risk - a.risk; });
  var closed = out.filter(function (l) { return l.type === 'closed'; })
    .sort(function (a, b) { return a.closedOn < b.closedOn ? 1 : -1; });
  return { open: open, closed: closed, today: today, dark: { no_followup: darkFollowup, quietSeries: quietSeries } };
}

/* Regroup everything by upcoming meeting. The list answers "what is outstanding";
 * an assistant is asked "what do I need before this". Same commitments, read the
 * way you read them the night before. */
function meetingBriefs(messages, events, open, opts) {
  var today = opts.today, execSide = side(opts.exec);
  var armed = {};
  events.forEach(function (e) { if (e.series && e.agenda) armed[e.series] = 1; });
  // Same rule as detectLoops: a series that never carries an agenda is not nagged.
  var watched = function (e) { return !e.series || !!armed[e.series]; };
  return events.map(function (e) {
    if (day(e.start) < today) return null;
    var ext = e.attendees.filter(function (a) { return side(a) !== execSide; });
    if (!ext.length) return null;
    var sides = ext.map(side);
    var items = open.filter(function (l) {
      if (l.eventId === e.id) return false;         // the agenda flag already says this
      return l.who && (ext.indexOf(l.who) > -1 || sides.indexOf(side(l.who)) > -1);
    }).sort(function (a, b) { return b.risk - a.risk; });
    var last = null;
    messages.forEach(function (m) {
      var party = m.from.toLowerCase() === opts.exec.toLowerCase() ? m.to : [m.from];
      if (party.some(function (p) { return sides.indexOf(side(p)) > -1; })) {
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
      prepDue: !e.agenda && watched(e) && prepBy <= today,      // runway closes today or has already gone
      prepLate: !e.agenda && watched(e) && prepBy < today,
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
  parseDue: parseDue, side: side, LABEL: LABEL, OWNER: OWNER, TIER_WEIGHT: TIER_WEIGHT
};
