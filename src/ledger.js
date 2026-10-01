/* Open Loops — the ledger.
 *
 * The detector is stateless on purpose: every run rebuilds the list from the mail.
 * That is right for the engine and wrong for a daily email. An unchanged list
 * arriving every morning is one nobody opens by Thursday, and a tool that gets
 * ignored on day four is indistinguishable from one that never worked.
 *
 * So this is the memory between runs: what was already on the list, what is new
 * today, what fell off because it got dealt with, and what the reader has told us
 * was never real in the first place.
 *
 * A spreadsheet rather than a database because the reader has to be able to type
 * in it. Marking an item wrong is the entire validation loop, and it has to cost
 * one keystroke or it does not get done for a fortnight running.
 */

var LEDGER_COLS = ['key', 'first_seen', 'last_seen', 'gone_on', 'type', 'who', 'what', 'verdict', 'who_id'];
var COL = {};
LEDGER_COLS.forEach(function (name, i) { COL[name] = i; });

function daysApart(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 864e5);
}

/* Sheets hands back a Date object for any cell it decided looks like one, which
 * would turn a stored '2026-08-06' into a string none of the comparisons here
 * expect. Normalise on the way in. The offset correction stops a local-midnight
 * Date sliding back a day when it goes through UTC. */
function cell(c) {
  if (c instanceof Date) {
    return new Date(c.getTime() - c.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }
  return c == null ? '' : String(c).trim();
}

/* The verdict is typed by a human into a spreadsheet cell, so accept the shapes a
 * human actually types. Anything else — blank included — means not yet judged. */
function isWrong(v) {
  return /^(x|n|no|nope|wrong|false|fp)\b/i.test(cell(v));
}

/* Real, but the reader already knew about it. Not a rejection — the item stays open
 * and stays on the list, because it is still outstanding. It only records that
 * surfacing it added nothing, which is the number that says whether this is useful
 * rather than merely accurate. */
function isKnown(v) {
  return /^(k|knew|known|already)\b/i.test(cell(v));
}

/* Fold this run's detections into what we already knew.
 *
 * Mutates `rows` (the sheet's contents) and annotates each surviving loop with
 * isNew / trackedDays so the digest can say what changed. Returns the loops that
 * should actually be shown — anything the reader marked wrong never reaches the
 * digest again. */
/* Rows written before a thread commitment's key named its channel are keyed "type|<root ts>|said|hash". Every
 * commitment with that root, sentence and day in ANY channel shares that one legacy key, and the row stores no
 * channel, so the only question is how many current commitments it could belong to. This answers it.
 *
 *   candidates  every current open or closed commitment: [{ key, channel }]. Commitments that already have
 *               rows under their own key count too, so an existing row cannot make a collision look unique.
 *   o.legacyKey maps a current key to its legacy form (loops.legacyKey); o.readsOk is true only if every
 *               conversation was read completely.
 *
 * One match, every read complete: the legacy row becomes that commitment's row (verdict and first_seen kept;
 * if the commitment already has a row of its own, the verdict moves into it unless it has one). One match but
 * an incomplete read: nothing changes, the legacy row is left exactly as it is and kept out of "cleared", and
 * the current commitment is tracked fresh until a complete run. Two or more matches: the record is applied to
 * neither and preserved under "<legacy key>|ambiguous", which no live key can equal, so it is reported once
 * and never matched again. Rows are changed in place; the caller rewrites stored digest memos from .renames. */
function reconcileLegacy(rows, candidates, o) {
  var groups = {}, byKey = {}, out = { renames: {}, ambiguous: [], deferred: {}, unowned: [] };
  candidates.forEach(function (c) {
    var lk = o.legacyKey(c.key);
    if (lk === c.key) return;
    var g = groups[lk] = groups[lk] || { keys: {}, channels: {}, people: {}, who: null };
    g.keys[c.key] = 1;
    if (c.channel) g.channels[c.channel] = 1;
    g.people[String(c.who == null ? '' : c.who).trim().toLowerCase()] = 1;
    if (g.who === null) g.who = c.who;
  });
  rows.forEach(function (r) { byKey[cell(r[COL.key])] = r; });
  Object.keys(groups).forEach(function (lk) {
    var row = byKey[lk];
    if (!row) return;
    var qs = Object.keys(groups[lk].keys);
    /* Ownership (o.owner / o.tokenOf, given by the Slack runner). A legacy row with a correction on it and nobody's name is not handed to
     * whoever appears now, even if only one person does: their appearance does not make the correction theirs. It is kept inert and reported. */
    var own = o.owner ? o.owner(row) : null;
    if (own && own.state === 'unknown' && cell(row[COL.verdict])) {
      out.unowned.push({ legacy: lk, people: Math.max(1, Object.keys(groups[lk].people).length) });
      row[COL.key] = lk + '|ambiguous';
      return;
    }
    if (qs.length > 1) {
      out.ambiguous.push({ legacy: lk, n: qs.length, channels: Object.keys(groups[lk].channels).sort(), verdict: cell(row[COL.verdict]) });
      row[COL.key] = lk + '|ambiguous';
      return;
    }
    if (!o.readsOk) { out.deferred[lk] = 1; return; }
    // A row that belongs to somebody else is not this commitment's: left as it is, and kept out of "cleared".
    if (own && own.state === 'known' && o.tokenOf && own.token !== o.tokenOf(groups[lk].who)) { out.deferred[lk] = 1; return; }
    var target = byKey[qs[0]];
    if (!target) {
      row[COL.key] = qs[0];
    } else {
      if (!cell(target[COL.verdict]) && cell(row[COL.verdict])) target[COL.verdict] = row[COL.verdict];
      if (cell(row[COL.first_seen]) && cell(row[COL.first_seen]) < cell(target[COL.first_seen])) target[COL.first_seen] = row[COL.first_seen];
      rows.splice(rows.indexOf(row), 1);
    }
    out.renames[lk] = qs[0];
  });
  return out;
}

function mergeLedger(rows, loops, today, opts) {
  var byKey = {}, touched = {}, shown = [], fresh = 0, suppressed = 0;
  // Retention mode: keep the key and the verdict, drop the words. Suppression still
  // works; what is lost is being able to read back what an item said.
  var keepText = !opts || opts.storeText !== false;
  var ident = opts && opts.identity;   // { token(who) } — only when the caller keeps people apart (the Slack runner does)
  rows.forEach(function (r) {
    // Before `who` is scrubbed, an older row's owner is written down as a token: that is all a scrubbed ledger keeps of it.
    if (ident && !/^[0-9a-f]{64}$/.test(cell(r[COL.who_id])) && cell(r[COL.who_id]) !== '~' && cell(r[COL.who])) r[COL.who_id] = ident.token(cell(r[COL.who]));
    if (!keepText) { r[COL.who] = ''; r[COL.what] = ''; }
    byKey[cell(r[COL.key])] = r;
  });

  loops.forEach(function (l) {
    var k = loopKey(l), row = byKey[k];
    touched[k] = 1;
    // A row a reply created before the item had one (see slack-run's marksFromDm) has no words yet.
    if (row && keepText && !cell(row[COL.what])) { row[COL.who] = l.who || ''; row[COL.what] = l.what || ''; }
    if (row && ident && !/^[0-9a-f]{64}$/.test(cell(row[COL.who_id]))) row[COL.who_id] = ident.token(l.who);   // a placeholder, or a row with no owner a lone person now continues

    if (row && isWrong(row[COL.verdict])) {
      /* Still detected, just hidden — so its clock has to keep running. Leaving
       * last_seen stale would let retention prune a row whose item is very much
       * alive, and it would come back the next morning as something brand new. */
      row[COL.last_seen] = today;
      suppressed++;
      return;
    }

    if (row) {
      row[COL.last_seen] = today;
      row[COL.gone_on] = '';                     // it is back, so it never left
      l.isNew = false;
      l.firstSeen = cell(row[COL.first_seen]);
      l.trackedDays = daysApart(l.firstSeen, today);
    } else {
      row = [k, today, today, '', l.type,
             keepText ? (l.who || '') : '', keepText ? (l.what || '') : '', ''];
      if (ident) row.push(ident.token(l.who));
      byKey[k] = row;
      rows.push(row);
      l.isNew = true;
      l.firstSeen = today;
      l.trackedDays = 0;
      fresh++;
    }
    shown.push(l);
  });

  /* Anything tracked that the detector no longer finds has been dealt with — the
   * reply landed, the agenda went out, the promise was kept. Worth saying once,
   * because a digest that only ever grows is a nag rather than a tool.
   *
   * Keyed on what this run actually produced rather than on last_seen matching
   * today, so that running the digest twice in one day does not quietly swallow
   * everything that cleared between the two.
   */
  var gone = [], aged = [], unknown = [];
  /* An item the reader muted is not an item that closed. It is absent from today's
     list because they said it was never real, which is the opposite of finished — and
     CLEARED is the one section of the digest that is pure good news. */
  var wasMuted = {};
  ((opts && opts.mutedKeys) || []).forEach(function (k) { wasMuted[k] = 1; });
  /* Said before the read window opened, so this run never looked for it at all.
   *
   * Reading only the last three weeks means a promise made twenty-two days ago is not
   * in today's messages whether or not anybody kept it — and absence was all this had
   * to go on. Run a digest, run another three weeks later, and every undelivered
   * promise in the ledger was announced under CLEARED at once. That is the failure the
   * whole tool exists to prevent, printed in the one section that is meant to be good
   * news. The key carries the date the commitment was made; meetings are keyed on an
   * event id instead, and are bounded by the calendar fetch rather than this window. */
  var windowStart = opts && opts.windowStart;
  var kept = (opts && opts.keepKeys) || {};
  rows.forEach(function (r) {
    if (touched[cell(r[COL.key])]) return;
    if (wasMuted[cell(r[COL.key])]) return;
    // A record kept for a reconcileLegacy decision is not a commitment that closed.
    if (kept[cell(r[COL.key])] || /[|]ambiguous$/.test(cell(r[COL.key]))) return;
    if (cell(r[COL.gone_on]) || isWrong(r[COL.verdict])) return;
    // Missing source data cannot prove completion. Explicit detector evidence can.
    var parts = cell(r[COL.key]).split('|');
    var item = { key: cell(r[COL.key]), what: cell(r[COL.what]), who: cell(r[COL.who]) };
    var said = parts[2];
    if (windowStart && /^\d{4}-\d{2}-\d{2}$/.test(said || '') && said < windowStart) {
      r[COL.gone_on] = today;
      aged.push(item);
      return;
    }
    var missingSource = opts && ((parts.length === 2 && opts.calendarRead === false) ||
      (parts.length > 2 && opts.availableThreads && opts.availableThreads.indexOf(parts[1]) === -1));
    if (opts && (opts.preserveMissing || missingSource) &&
        (opts.closedKeys || []).indexOf(cell(r[COL.key])) === -1) {
      unknown.push({ key: cell(r[COL.key]), what: cell(r[COL.what]), who: cell(r[COL.who]) });
      return;
    }
    r[COL.gone_on] = today;
    // Reported as plain fields rather than a raw row, so whatever renders this does
    // not need to know the ledger's column layout.
    gone.push(item);
  });

  return { shown: shown, fresh: fresh, suppressed: suppressed, gone: gone, aged: aged, unknown: unknown };
}

/* The two numbers the fortnight is for.
 *
 * Precision says whether the list can be trusted. It does not say whether the list is
 * worth reading — someone with a good memory could get a flawless digest every morning
 * and gain nothing from it, because they already knew all of it. What this exists to
 * catch is the thing that fell out of everyone's head three weeks ago, so the count
 * that matters is how much of it was genuinely news.
 *
 * ponytail: an unmarked row counts as both correct and novel, which flatters both
 * numbers. Explicit judgement on every item is the honest measure and nobody sustains
 * it for two weeks; a test that gets abandoned yields nothing at all. Mark the misses.
 */
function precision(rows) {
  var byType = {}, total = 0, wrong = 0, knew = 0;
  rows.forEach(function (r) {
    var t = cell(r[COL.type]) || '?';
    var b = byType[t] || (byType[t] = { total: 0, wrong: 0, knew: 0 });
    b.total++; total++;
    if (isWrong(r[COL.verdict])) { b.wrong++; wrong++; }
    else if (isKnown(r[COL.verdict])) { b.knew++; knew++; }
  });
  return { total: total, wrong: wrong, knew: knew, byType: byType,
           news: total - wrong - knew };
}

/* Forget rows nothing has matched for a while.
 *
 * The ledger is a second place email content lives, so "how long do you keep this"
 * is a question someone will ask and the answer has to be a number rather than
 * "forever". Age runs from last_seen, which every run refreshes for anything still
 * being detected — including items hidden as wrong — so an item that is still live
 * is never pruned out from under itself.
 *
 * Mutates rows in place, since that is what gets written back. */
function pruneLedger(rows, today, keepDays) {
  if (!keepDays) return 0;
  var kept = rows.filter(function (r) {
    var seen = cell(r[COL.last_seen]);
    return !seen || daysApart(seen, today) < keepDays;
  });
  var dropped = rows.length - kept.length;
  rows.length = 0;
  kept.forEach(function (r) { rows.push(r); });
  return dropped;
}

/* --- learning the kind, not just the instance ---
 *
 * A verdict suppresses one row, keyed to one sentence in one conversation. That is
 * right for a one-off, and useless for a habit: if "we'll need to look at that at
 * some point" is never a commitment worth tracking, every fresh instance of it
 * arrives as a new item and gets rejected again, forever.
 *
 * So rejections are also read as evidence about phrasing. Nothing is applied
 * automatically — the tool proposes, a person decides, and what they decide sits in
 * config where it can be read and undone. A detector that quietly rewrites its own
 * rules is one nobody can predict or audit, and predictability is most of why this
 * is regexes rather than a model.
 */

/* Word n-grams, so suggestions are phrases a person recognises rather than tokens. */
function phrases(text, n) {
  var w = String(text || '').toLowerCase().match(/[a-z][a-z']*/g) || [];
  var out = [];
  for (var i = 0; i + n <= w.length; i++) out.push(w.slice(i, i + n).join(' '));
  return out;
}

/* Phrases that recur in what someone rejected and appear in nothing they kept.
 *
 * The second half is what makes it worth reading. "i'll send" is all over the
 * rejections and all over the real items too, so it says nothing. A phrase that shows
 * up only in the misses is a pattern the detector is wrong about.
 *
 * ponytail: no minimum number of judged rows is required — two rejections of a phrase are enough to propose it. Frequency over a small
 * corpus is mostly noise, so add a judged-count gate here if proposals made over a handful of rows prove noisy. Only the fourth rejection
 * (minCount 4) ever acts on its own. */
function suggestMutes(rows, minCount) {
  minCount = minCount || 2;
  var wrong = {}, kept = {};
  rows.forEach(function (r) {
    var bad = isWrong(r[COL.verdict]);
    [2, 3, 4].forEach(function (n) {
      phrases(cell(r[COL.what]), n).forEach(function (p) {
        if (bad) wrong[p] = (wrong[p] || 0) + 1;
        else kept[p] = 1;
      });
    });
  });

  var found = Object.keys(wrong)
    .filter(function (p) { return wrong[p] >= minCount && !kept[p]; })
    .sort(function (a, b) { return wrong[b] - wrong[a] || b.length - a.length; });

  /* Overlapping n-grams say the same thing three times — "at some", "some point",
   * "at some point". Keep the longest of each nested set. */
  return found
    .filter(function (p) {
      return !found.some(function (q) {
        return q !== p && q.length > p.length && q.indexOf(p) > -1 && wrong[q] === wrong[p];
      });
    })
    .slice(0, 8)
    .map(function (p) { return { phrase: p, count: wrong[p] }; });
}

/* Drop anything whose text contains a muted phrase.
 *
 * Substring, case-insensitive, and deliberately not a regex. A mute list is read by
 * someone deciding whether it is too broad, and a list of regexes is a list nobody
 * checks. Returns what survives; the caller reports how many did not. */
function applyMutes(loops, patterns) {
  var mute = (patterns || []).map(function (p) { return String(p).toLowerCase(); })
                             .filter(Boolean);
  if (!mute.length) return loops.slice();
  return loops.filter(function (l) {
    var t = String(l.what || '').toLowerCase();
    /* Match the raw text AND the shape phrases() produces. A learned phrase is
     * letters-only joined by single spaces, so one lifted from "pricing, at some
     * point" comes out as "pricing at some point" and can never appear literally in
     * the sentence it came from — it was announced as an active rule and silently did
     * nothing. Raw is kept as well, because a hand-written mute may contain a digit or
     * a hyphen that normalising would destroy. */
    var flat = (t.match(/[a-z][a-z']*/g) || []).join(' ');
    return !mute.some(function (p) { return t.indexOf(p) > -1 || flat.indexOf(p) > -1; });
  });
}

/* --- how long each person actually takes ---
 *
 * Everyone is chased on the same clock, and that clock is whatever they said. But Paul
 * at Meridian always takes ten days, and flagging him on day three because he said
 * Friday is worse than not flagging him at all — chasing somebody who is behaving
 * completely normally costs credibility with exactly the people the tiers say matter
 * most.
 *
 * The ledger already knows this without being told. Every cleared row carries when it
 * first appeared and when it stopped being detected, and the gap between those is how
 * long that person took. Nobody has to record anything.
 */
function tempos(rows, minSamples, windowDays) {
  var min = minSamples || 3, byWho = {};

  rows.forEach(function (r) {
    // Only what they owed us. How long *we* take says nothing about when to chase them.
    var type = cell(r[COL.type]);
    if (type !== 'owed_to_us' && type !== 'awaiting_reply') return;

    var from = cell(r[COL.first_seen]), done = cell(r[COL.gone_on]);
    if (!from || !done) return;                 // still open, so it says nothing yet

    var who = cell(r[COL.who]).toLowerCase();
    if (!who) return;
    var days = daysApart(from, done);
    if (days < 0) return;
    /* An item stops being detected for two reasons and the ledger records only one of
     * them: they delivered, or the message aged out of the read window. A sample at or
     * beyond the window is indistinguishable from the second, and learning from it
     * teaches that this person takes exactly as long as the window — which then damps
     * the overdue escalation and stops them being chased at all. Where the two cannot
     * be told apart, do not learn from it. */
    if (windowDays && days >= windowDays) return;
    /* The same test against when it was said, not when the ledger first saw it. A
     * promise already old on the first run ages out soon afterwards, and first_seen to
     * gone_on then reads as a quick turnaround from somebody who never delivered. */
    var said = cell(r[COL.key]).split('|')[2];
    if (windowDays && /^\d{4}-\d{2}-\d{2}$/.test(said || '') &&
        daysApart(said, done) >= windowDays) return;
    (byWho[who] = byWho[who] || []).push(days);
  });

  /* Median rather than mean: one counterparty who vanished for three months would
   * otherwise drag their own average past anything useful. */
  var out = {};
  Object.keys(byWho).forEach(function (who) {
    var d = byWho[who].sort(function (a, b) { return a - b; });
    // Two data points is a coincidence. Below the threshold, say nothing.
    if (d.length < min) return;
    var mid = Math.floor(d.length / 2);
    out[who] = d.length % 2 ? d[mid] : Math.round((d[mid - 1] + d[mid]) / 2);
  });
  return out;
}

/* --- checking what it never showed you ---
 *
 * Every verdict so far is about something that appeared: this item is wrong, this one
 * I knew. None of it can say anything about what was missed, because a miss produces
 * nothing to reject. So the correction loop can only ever teach it to be quieter,
 * never more thorough — and the two worst bugs found in this detector were both
 * false negatives, invisible to every number it reports.
 *
 * The fix is to sample the silence. Show a handful of messages the detector found
 * nothing in and ask whether it should have. That is the only cheap evidence about
 * recall there is, and a handful is enough because it is an estimate, not a census.
 */

/* Deterministic pick, so re-running a day does not reshuffle what was asked about and
 * an answer given yesterday still lines up with what it answered. */
function hashId(s) {
  var h = 2166136261;
  String(s).split('').forEach(function (c) {
    h ^= c.charCodeAt(0);
    h = (h * 16777619) >>> 0;
  });
  return h;
}

function sampleQuiet(messages, loops, n, salt) {
  var noisy = {};
  loops.forEach(function (l) { if (l.msgId) noisy[l.msgId] = 1; });
  return messages
    .filter(function (m) { return !noisy[m.id] && String(m.body || '').trim().length > 20; })
    .sort(function (a, b) { return hashId(salt + a.id) - hashId(salt + b.id); })
    .slice(0, n || 0);
}

/* Of the silence we sampled, how much of it was not silent.
 *
 * ponytail: this is an estimate from a small sample and reads as more precise than it
 * is. Ten messages a day for a fortnight is a hundred and forty — enough to tell a
 * detector that misses a third of everything from one that misses almost nothing, and
 * not enough to put a confidence interval on. Treat it as an order of magnitude. */
function recall(found, quiet, checked, missed) {
  if (!checked || !found) return null;
  var estimatedMisses = quiet * (missed / checked);
  return {
    checked: checked, missed: missed, quiet: quiet, found: found,
    rate: Math.round(found / (found + estimatedMisses) * 100),
    estimatedMisses: Math.round(estimatedMisses)
  };
}

/* --- marking things wrong by replying to the digest ---
 *
 * The spreadsheet works, and nobody opens it. Marking a false positive has to cost
 * about as much as ignoring one or it does not happen for a fortnight running, which
 * is exactly how long the measurement takes.
 *
 * So the digest numbers its items and you reply to the email with the numbers that
 * are not real. The next run reads the reply and marks them.
 */

/* Numbers a human typed, bounded by how many items that digest actually had.
 *
 * Only standalone numbers count. A date or a time is a run of digits joined by
 * separators, and "2026-08-25" would otherwise offer up 8 and 25 as marks — people
 * quote dates when explaining which item they mean, so this is the common case
 * rather than the corner one.
 *
 * ponytail: still takes every in-range standalone integer, so "3 is wrong, the other
 * 12 look fine" marks 12 as well. The digest asks for bare numbers, and a stray mark
 * costs one suppressed item that returns the moment the cell is cleared. Require a
 * leading keyword if that turns out to bite. */
/* One mark, or one range of marks, that stands alone: not part of a date, a time, a fraction or a chain of numbers. */
var RANGE_SEP = '(?:\\s*[-–—]\\s*|\\s+(?:to|through|thru)\\s+)';
var STAND_ALONE = '(?![\\d\\-\\/:a-z]|\\.\\d)(?!\\s*[-–—\\/]\\s*\\d)';
var TOKEN = new RegExp('(?<![\\d\\-\\/:]|\\d\\.)#?(\\d+)(?:' + RANGE_SEP + '#?(\\d+))?' + STAND_ALONE, 'gi');
/* A range is read only when the WHOLE line is correction syntax: marks and ranges, separated by spaces, commas, "and" or &, after an optional label
 * (k / knew / known / already, which the caller has already taken off). "4 to 6 weeks for the rollout" leads with a range and is conversation. */
var ITEM = '#?\\d+(?:' + RANGE_SEP + '#?\\d+)?';
var WHOLE_LINE = new RegExp('^\\s*' + ITEM + '(?:(?:\\s*[,;&]\\s*|\\s+and\\s+|\\s+)' + ITEM + ')*\\s*[.!]*\\s*$', 'i');
var LEAD = new RegExp('^\\s*#?(\\d+)(?:' + RANGE_SEP + '#?(\\d+))?' + STAND_ALONE, 'i');
/* "all" and "everything" are not supported, on purpose: rejecting a whole list is what a paste looks like. They are reported, not applied. */
var EVERYTHING = /^\s*(?:(?:reject|delete|remove|drop|clear|mark)\s+)?(?:all(?:\s+of\s+(?:them|these|it))?|everything)(?:\s+(?:is\s+)?(?:wrong|not real|false))?\s*[.!]*\s*$/i;
/* A line made only of digits and separators that names no item and is not a date: "1/3" or "1-3-5" (every number an item, joined the wrong way),
 * or bare numbers past the end of the list ("9" on a list of 8). "9/30" and "2026-08-25" have numbers that are not items, so they are dates. */
function unsupportedShape(line, max) {
  var t = line.trim();
  if (!/^#?\d+(?:\s*[,;\s\/\-–—]\s*#?\d+)*\s*[.!]*$/.test(t)) return false;
  var ns = (t.match(/\d+/g) || []).map(Number), seps = t.replace(/[\d#\s.!]/g, ''), inList = ns.every(function (n) { return n >= 1 && n <= max; });
  return /^[,;]*$/.test(seps) ? !inList : inList;
}

/* A line that is only numbers and punctuation, where two item numbers are joined by something that is not a range, a list or a decimal: "1..3", "1~3",
 * "1‐3" (a Unicode hyphen), "1 → 3". It was half-read as 1 and 3, silently skipping what was between them. It is reported, and nothing is applied. */
function junkSeparated(line, max) {
  var t = line.trim();
  if (!/^[\d\s\p{P}\p{S}]+$/u.test(t)) return false;
  var ns = (t.match(/\d+/g) || []).map(Number), seps = t.split(/\d+/).slice(1, -1).map(function (x) { return x.replace(/[#\s]/g, ''); }), bad = false;
  if (ns.length < 2 || !ns.every(function (n) { return n >= 1 && n <= max; })) return false;
  seps.forEach(function (x) { if (!/^[,;&]*$/.test(x) && x !== '.' && x !== ':' && !/^[\/\-–—]$/.test(x)) bad = true; });
  return bad;
}

function parseMarks(text, max) {
  var wrong = [], knew = [], missed = [], ignored = [], unread = [], badRange = [], rangesWrong = [], rangesKnew = [], seen = {}, seenLetter = {};
  /* Whether the spot check was answered at all, which is not the same as whether it
   * named a miss. A bare `miss` means "none of these" and is the answer that makes the
   * clean ones count; no miss line at all means they did not look, and counting the
   * sample as reviewed on the strength of any reply at all invents the only evidence
   * about recall that exists. */
  var answered = false;
  String(text || '').split(/\r?\n/).forEach(function (line) {
    /* A line led by miss names spot-check entries that did contain a commitment.
     * Those are lettered rather than numbered precisely so the two cannot be
     * confused: "3" is always a rejection, "c" is always a miss. */
    if (/^\s*(m|miss|missed)\b/i.test(line)) {
      answered = true;
      /* Letters are read only as a run straight after the keyword ("miss b d", "miss b and d"). Every standalone letter in the line
       * used to count, so "miss none, a clean sample" named a miss and lowered the recall. A lone "a" or "I" followed by prose is a word. */
      var toks = line.replace(/^\s*\w+/, '').split(/[\s,;:]+/).filter(Boolean), run = [], ti = 0;
      for (; ti < toks.length; ti++) {
        var tk = toks[ti].replace(/[.!?]+$/, '');
        if (/^(and|&)$/i.test(tk)) continue;
        if (/^[a-z]$/i.test(tk)) run.push(tk.toLowerCase()); else break;
      }
      if (ti < toks.length && run.length === 1 && (run[0] === 'a' || run[0] === 'i')) run = [];
      run.forEach(function (L) { if (!seenLetter[L]) { seenLetter[L] = 1; missed.push(L); } });
      return;
    }
    /* A line led by k / knew / already means "real, but I knew" — the difference
     * between measuring whether this is trustworthy and whether it is any use.
     * Bare numbers stay a rejection, so the common case costs nothing extra. */
    var known = /^\s*(k|knew|known|already)\b/i.test(line);
    var body = known ? line.replace(/^\s*(k|knew|known|already)\b/i, '') : line;

    /* A standalone number, or a range of them: "3", "1-3", "1 to 3". A digit glued to a letter is a time or a quantity, not an item number —
     * "3pm", "2x", "5min" — and "1-3pm" is a time range, so neither end of it is read. A date or a fraction ("9/30", "2026-08-25") is digits joined
     * by separators and is not read either, nor is a chain ("1-3-5"). */
    /* `any`: a single number was named. Only that is reported when the line does not lead with it; a range in a note ("see pages 2-5") was never reported. */
    if (max && junkSeparated(body, max)) { unread.push(line.trim()); return; }
    var tokens = [], bad = false, any = false, sawRange = false, m;
    TOKEN.lastIndex = 0;
    while ((m = TOKEN.exec(body))) {
      var a = Number(m[1]), b = m[2] === undefined ? a : Number(m[2]);
      if (m[2] === undefined) { if (a >= 1 && a <= max) { tokens.push([a, a]); any = true; } continue; }
      sawRange = true;
      /* A range is checked against the list BEFORE it is expanded, so "1-999999999" allocates nothing. A reversed one, or one that runs past the
       * list, is not clamped to something that looks right: it is not read at all. */
      if (a >= 1 && a <= b && b <= max) tokens.push([a, b]); else if (max) bad = true;    // with no list there is nothing to be out of range of
    }
    /* A range inside a line that is anything more than marks and ranges is part of a sentence: nothing on that line is read, not the range and
     * not the numbers beside it, and it is not reported either. */
    if (sawRange && !WHOLE_LINE.test(body)) {
      if (max && unsupportedShape(line, max)) unread.push(line.trim());    // "1 - 3 - 5" is numbers only, and cannot be read
      return;
    }
    if (!tokens.length && !bad) {
      /* Nothing here names an item, but the line may still be a correction that cannot be read: "all", or numbers that are not item numbers
       * ("1/3", "9" on a list of 8). Reported, never applied. Ordinary conversation has words in it, so it is left alone. */
      if (max && (EVERYTHING.test(line) || unsupportedShape(line, max))) unread.push(line.trim());
      return;
    }

    /* The line has to LEAD with the mark.
     *
     * This used to take numbers out of any line at all, which made "3 and 7 arent real"
     * work and made "call Dana at 3" reject item 3 — and those two are the same shape,
     * so no rule separates them by meaning. The self-DM is where people keep notes,
     * because it is the one channel that is only theirs, and this tool posts there daily
     * and asks for replies. It was putting a trap in the channel it drives traffic to.
     *
     * A false rejection is the expensive failure: the item is hidden from every future
     * digest, nobody is told, and four of them on one phrase auto-mute the whole
     * pattern. A missed correction costs a retype, and the item still sitting there
     * tomorrow is the reminder. So: lead with the number, as the digest asks. Anything
     * else is recorded and reported rather than acted on. */
    /* The lead has to BE a mark: a standalone number in range. "3pm call with Dana moved to 4" starts with a digit and is not one. */
    var lead = body.match(LEAD);
    var leadsWithMark = lead && (lead[2] !== undefined || (+lead[1] >= 1 && +lead[1] <= max));
    if (!leadsWithMark) {
      if (any) ignored.push(line.trim());
      else if (max && unsupportedShape(line, max)) unread.push(line.trim());    // "1 - 3 - 5": numbers only, joined in a way that is not a range
      return;
    }
    /* One range that cannot be read makes the whole line unreadable: the numbers beside it are not applied on the strength of a line that was
     * half understood. */
    if (bad) { unread.push(line.trim()); badRange.push(line.trim()); return; }

    tokens.forEach(function (tk) {
      if (tk[0] < tk[1]) (known ? rangesKnew : rangesWrong).push(tk);
      for (var n = tk[0]; n <= tk[1]; n++) {
        if (seen[n]) continue;
        seen[n] = 1;
        (known ? knew : wrong).push(n);
      }
    });
  });
  /* `ignored` is every line that named an item number but did not lead with one.
     Reported rather than acted on, so a reply that was not read never fails silently. */
  return { wrong: wrong, knew: knew, missed: missed, ignored: ignored, unread: unread, badRange: badRange, ranges: { wrong: rangesWrong, knew: rangesKnew }, answered: answered };
}

/* Resolve those numbers against the list as it was sent, not as it stands now —
 * item 3 this morning is not item 3 tomorrow. Returns how many were newly marked.
 * Only ever fills a blank verdict, so re-reading the same reply changes nothing. */
/* A row for an item a reply names before the ledger has one.
 *
 * A same-day re-run starts from before the day's first run, so an item that first
 * appeared in that run has no row yet — and a rejection with no row to land on was
 * dropped without a word. The verdict goes on this; mergeLedger fills in the words. */
function placeholderRow(key, date) {
  return [key, date, date, '', String(key).split('|')[0], '', '', '', '~'];   // '~': it belongs to whoever fills it
}

function applyMarks(rows, keys, marks) {
  var byKey = {}, n = 0;
  rows.forEach(function (r) { byKey[cell(r[COL.key])] = r; });
  var set = function (nums, verdict) {
    (nums || []).forEach(function (i) {
      var row = byKey[keys[i - 1]];
      if (row && !cell(row[COL.verdict])) { row[COL.verdict] = verdict; n++; }
    });
  };
  set(marks.wrong, 'x');
  set(marks.knew, 'k');
  return n;
}

if (typeof module !== 'undefined') {
  module.exports = {
    mergeLedger: mergeLedger, precision: precision, isWrong: isWrong, isKnown: isKnown,
    cell: cell, daysApart: daysApart, parseMarks: parseMarks, applyMarks: applyMarks, placeholderRow: placeholderRow,
    reconcileLegacy: reconcileLegacy,
    pruneLedger: pruneLedger, suggestMutes: suggestMutes, applyMutes: applyMutes,
    phrases: phrases, sampleQuiet: sampleQuiet, recall: recall, tempos: tempos,
    LEDGER_COLS: LEDGER_COLS, COL: COL
  };
}
