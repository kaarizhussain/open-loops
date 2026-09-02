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

var LEDGER_COLS = ['key', 'first_seen', 'last_seen', 'gone_on', 'type', 'who', 'what', 'verdict'];
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
function mergeLedger(rows, loops, today, opts) {
  var byKey = {}, touched = {}, shown = [], fresh = 0, suppressed = 0;
  // Retention mode: keep the key and the verdict, drop the words. Suppression still
  // works; what is lost is being able to read back what an item said.
  var keepText = !opts || opts.storeText !== false;
  rows.forEach(function (r) { byKey[cell(r[COL.key])] = r; });

  loops.forEach(function (l) {
    var k = loopKey(l), row = byKey[k];
    touched[k] = 1;

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
   * ponytail: an item also falls off when its thread ages past lookbackDays, so a
   * long-silent loop reads as resolved when it was only forgotten. If that starts
   * lying, diff against the thread ids actually read rather than trusting absence.
   *
   * Keyed on what this run actually produced rather than on last_seen matching
   * today, so that running the digest twice in one day does not quietly swallow
   * everything that cleared between the two.
   */
  var gone = [];
  rows.forEach(function (r) {
    if (touched[cell(r[COL.key])]) return;
    if (cell(r[COL.gone_on]) || isWrong(r[COL.verdict])) return;
    r[COL.gone_on] = today;
    // Reported as plain fields rather than a raw row, so whatever renders this does
    // not need to know the ledger's column layout.
    gone.push({ key: cell(r[COL.key]), what: cell(r[COL.what]), who: cell(r[COL.who]) });
  });

  return { shown: shown, fresh: fresh, suppressed: suppressed, gone: gone };
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
 * ponytail: needs a couple of dozen judged rows before it says anything useful, and
 * says nothing rather than guessing below that. Frequency over a small corpus is
 * mostly noise, and a confident wrong suggestion here costs more than silence — it
 * would be muting real commitments. */
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
    return !mute.some(function (p) { return t.indexOf(p) > -1; });
  });
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
function parseMarks(text, max) {
  var wrong = [], knew = [], missed = [], seen = {}, seenLetter = {};
  String(text || '').split(/\r?\n/).forEach(function (line) {
    /* A line led by miss names spot-check entries that did contain a commitment.
     * Those are lettered rather than numbered precisely so the two cannot be
     * confused: "3" is always a rejection, "c" is always a miss. */
    if (/^\s*(m|miss|missed)\b/i.test(line)) {
      (line.replace(/^\s*\w+/, '').match(/\b[a-z]\b/gi) || []).forEach(function (c) {
        var L = c.toLowerCase();
        if (!seenLetter[L]) { seenLetter[L] = 1; missed.push(L); }
      });
      return;
    }
    /* A line led by k / knew / already means "real, but I knew" — the difference
     * between measuring whether this is trustworthy and whether it is any use.
     * Bare numbers stay a rejection, so the common case costs nothing extra. */
    var known = /^\s*(k|knew|known|already)\b/i.test(line);
    // A full stop only disqualifies when it joins two digit runs — "item 4." is a mark,
    // "3.5" is not, and a sentence ending in a number is how people actually write.
    (line.match(/(?<![\d\-\/:]|\d\.)\d+(?![\d\-\/:]|\.\d)/g) || []).forEach(function (s) {
      var n = +s;
      if (n < 1 || n > max || seen[n]) return;
      seen[n] = 1;
      (known ? knew : wrong).push(n);
    });
  });
  return { wrong: wrong, knew: knew, missed: missed };
}

/* Resolve those numbers against the list as it was sent, not as it stands now —
 * item 3 this morning is not item 3 tomorrow. Returns how many were newly marked.
 * Only ever fills a blank verdict, so re-reading the same reply changes nothing. */
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
    cell: cell, daysApart: daysApart, parseMarks: parseMarks, applyMarks: applyMarks,
    pruneLedger: pruneLedger, suggestMutes: suggestMutes, applyMutes: applyMutes,
    phrases: phrases, sampleQuiet: sampleQuiet, recall: recall,
    LEDGER_COLS: LEDGER_COLS, COL: COL
  };
}
