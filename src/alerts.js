/* Midday alerts — deciding what changed since the last digest, and what to say about it.
 *
 * The evening digest lists everything outstanding. This answers a narrower question, asked
 * at 12:00 and 15:00: has anything become urgent since the reader last looked? It
 * uses the detector's own fields (status, workDue, earlyForThem, tier weight) and adds no
 * judgement of its own — the rules below are comparisons, not inference.
 *
 * State is two files beside the config, one writer each, because the digest task and the checks
 * task can overlap (a catch-up run after the app was closed, a long digest, a run by hand):
 *   alerts-baseline.json  written by the digest only: what it showed, under a new version each time
 *   alerts.json           written by the checks task only: what it alerted and which slots ran,
 *                         tagged with the baseline version it was compared against
 * Neither reads the other's file to write its own, so neither can lose the other's update. Check
 * state whose version is not the current baseline's loses its item dedupe (alerted, pending items):
 * the digest has since shown the reader everything. It keeps which slots ran that calendar day, so a
 * new baseline never reopens a 12:00 or 15:00 check that already completed. The ledger is never written by a check. No network
 * here; posting is the caller's job, like the digest's.
 */
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var loops = require('./loops.js');

var keyOf = loops.loopKey;

var DEFAULT_TIMES = ['12:00', '15:00'];
var LATE_MINUTES = 120;          // a check this much later than its slot is skipped
var CHECKS_END = 17 * 60;        // no configured check time may be at or after 17:00
var CHECK_FROM = 8 * 60;         // and no check runs before 08:00
var MAX_ITEMS = 5;
var PRIORITY_WEIGHT = 20;        // key_account, investor, exec (TIER_WEIGHT in loops.js)
var KEEP_DAYS = 7;

var HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
var DAY = /^\d{4}-\d{2}-\d{2}$/;

/* On is a record written by `alerts.js --consent --yes`, never a flag someone can flip back.
 * Anything unrecognised is off: a config typo must not start reading channels. */
function consent(cfg) {
  var a = cfg && cfg.alerts;
  if (!a || typeof a !== 'object' || a.delivery !== 'dm') return null;
  if (!/^\d{4}-\d{2}-\d{2}T/.test(String(a.consentedAt || ''))) return null;
  var times = a.times || DEFAULT_TIMES;
  if (!Array.isArray(times) || !times.length || times.length > 3 ||
      !times.every(function (t) { return HHMM.test(t) && toMin(t) >= CHECK_FROM && toMin(t) < CHECKS_END; })) return null;
  var sorted = times.slice().sort();
  if (sorted.join() !== times.join()) return null;
  return { delivery: 'dm', consentedAt: a.consentedAt, times: times };
}

function toMin(hhmm) { return parseInt(hhmm.slice(0, 2), 10) * 60 + parseInt(hhmm.slice(3), 10); }
function pad(n) { return (n < 10 ? '0' : '') + n; }

// The machine's own clock, not the config's tzOffset: that is a fixed number of minutes and
// drifts an hour when the clocks change, and the scheduler fires on this clock.
function localParts(now) {
  var d = now instanceof Date ? now : new Date(now);
  return { date: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()),
           min: d.getHours() * 60 + d.getMinutes(), dow: d.getDay() };
}
// "2026-10-01T12:03" (no zone) means local time, so tests do not depend on the machine's.
function parseNow(s) {
  var m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : new Date();
}
function daysApart(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 864e5);
}
function addDays(date, n) {
  return new Date(new Date(date + 'T00:00:00Z').getTime() + n * 864e5).toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ state file */

function file(dir) { return path.join(dir, 'alerts.json'); }                  // the checks task's
function baselineFile(dir) { return path.join(dir, 'alerts-baseline.json'); }  // the digest's
function stagedFile(dir) { return path.join(dir, 'alerts-baseline.next.json'); }  // the digest's, until it is posted

/* The other task may have this file open or be renaming over it at this moment. On Windows that
 * fails with EPERM/EBUSY/EACCES instead of waiting, so those are retried briefly. */
var BUSY = { EPERM: 1, EBUSY: 1, EACCES: 1 };
function retry(fn) {
  for (var i = 0; ; i++) {
    try { return fn(); } catch (e) {
      if (!BUSY[e.code] || i >= 40) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 + i);
    }
  }
}

// A missing or torn file reads as "nothing there", never as half a record.
function readJson(f) {
  try { var s = JSON.parse(retry(function () { return fs.readFileSync(f, 'utf8'); })); return s && typeof s === 'object' ? s : {}; }
  catch (e) { return {}; }
}

// Renamed into place, so a reader sees the old file or the new one, whole.
function writeJson(f, o) {
  var tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(o, null, 1));
  retry(function () { fs.renameSync(tmp, f); });
}

function loadBaseline(dir) {
  var b = readJson(baselineFile(dir));
  return b.version && typeof b.version === 'string' && b.items && typeof b.items === 'object' ? b : null;
}

/* Both files, as one view. Check state from another baseline version loses its item dedupe: alerted
 * is empty and a pending alert keeps only its slot, so confirming it still completes that slot. Slots
 * that ran are kept, since the baseline changing does not un-run a check. */
function load(dir) {
  var baseline = loadBaseline(dir), s = readJson(file(dir));
  var same = !!baseline && s.baselineVersion === baseline.version;
  return { baseline: baseline,
           alerted: same && s.alerted && typeof s.alerted === 'object' ? s.alerted : {},
           slots: s.slots && typeof s.slots === 'object' ? s.slots : {},
           pending: !s.pending ? null : same ? s.pending : { date: s.pending.date, slot: s.pending.slot, alerts: {} } };
}

/* The checks task's file only. It names the baseline version its contents were compared against;
 * the baseline itself is never written here. */
function save(dir, s) {
  var keep = {}, cutoff = addDays(localParts(new Date()).date, -KEEP_DAYS);
  Object.keys(s.slots).forEach(function (d) { if (d >= cutoff) keep[d] = s.slots[d]; });
  writeJson(file(dir), { baselineVersion: s.baseline.version, alerted: s.alerted, slots: keep, pending: s.pending });
}

/* ------------------------------------------------------------------ the rules */

/* How urgent an item is, on the detector's terms. 0 means never worth an alert.
 *   3  overdue (unless the detector damps it as early for them)
 *   2  due today
 *   1  a priority contact's item due tomorrow — only a new item alerts at this level
 * Undated items are always 0: they stay in the evening digest. */
function level(item, today) {
  if (!item || !item.due || !item.workDue) return 0;
  if (item.status === 'overdue') return item.earlyForThem ? 0 : 3;
  if (item.status === 'due_today') return 2;
  var weight = item.rel && item.rel.weight || 0;
  if (weight >= PRIORITY_WEIGHT && daysApart(today, item.workDue) === 1) return 1;
  return 0;
}

/* What the digest just showed, remembered so the next check can tell what changed. */
function baselineOf(open, today) {
  var items = {};
  open.forEach(function (l) { items[keyOf(l)] = level(l, today); });
  return { date: today, items: items };
}

/* What the digest showed, kept aside under the digest's own reference until that digest is posted and
 * read back. The runner only prints the digest: nothing has reached the reader yet, so the checks
 * must not compare against it (a post that fails or comes back wrong would move the baseline to a
 * list the reader never saw, and every check after it would alert on the wrong changes). */
function stageBaseline(dir, open, today, ref) {
  var b = baselineOf(open, today);
  b.ref = ref;
  writeJson(stagedFile(dir), b);
}

/* Called once the digest is in the DM and read back: that digest's baseline becomes the baseline, under
 * a new version. Anything alerted since is now part of it, and the checks task sees the new version and
 * starts its own record again. Only the digest that was staged can be promoted: a ref that is not the
 * staged one promotes nothing. This and stageBaseline are the only writers of the baseline files. */
function promoteBaseline(dir, ref) {
  var s = readJson(stagedFile(dir));
  if (!ref || s.ref !== ref || !s.items || typeof s.items !== 'object') return null;
  var b = { date: s.date, items: s.items, version: crypto.randomBytes(8).toString('hex') };
  writeJson(baselineFile(dir), b);
  try { retry(function () { fs.unlinkSync(stagedFile(dir)); }); } catch (e) { /* a leftover is harmless: it is consumed by ref */ }
  return b;
}

/* Kept for callers that already know the digest was posted. */
function writeBaseline(dir, open, today) {
  var b = baselineOf(open, today);
  b.version = crypto.randomBytes(8).toString('hex');
  writeJson(baselineFile(dir), b);
}

/* Items that changed since the baseline and have not been alerted at this level.
 *   verdictOf(key) — the ledger's verdict for an item: rejected and already-known ones never alert. */
function evaluate(open, state, today, verdictOf) {
  var out = [];
  open.forEach(function (l) {
    var key = keyOf(l), v = verdictOf ? String(verdictOf(key) || '') : '';
    if (/^(x|n|no|nope|wrong|false|fp|k|knew|known|already)\b/i.test(v)) return;
    var lv = level(l, today);
    var inBaseline = Object.prototype.hasOwnProperty.call(state.baseline.items, key);
    var seen = Math.max(inBaseline ? state.baseline.items[key] : 0, state.alerted[key] || 0);
    if (lv < (inBaseline ? 2 : 1) || lv <= seen) return;
    out.push({ key: key, item: l, level: lv, fresh: !inBaseline });
  });
  out.sort(function (a, b) { return (b.item.risk || 0) - (a.item.risk || 0); });
  return out;
}

/* ------------------------------------------------------------------ deciding the run */

/* What a run of the checks task should do, from the clock and the files alone — nothing is
 * fetched to find out. `OFF` means alerts are not on: the task has nothing to do and pauses itself.
 * The evening digest is a different task and never comes through here, so a missed digest is that
 * task's own catch-up and a check can never replace it. */
function decide(cfg, now, dir) {
  var c = consent(cfg);
  var t = localParts(now);
  if (!c) return { run: 'OFF', reason: 'alerts are off, so this task has nothing to do' };
  if (t.dow === 0 || t.dow === 6) return { run: 'SKIP', reason: 'weekend: checks run on weekdays' };
  if (t.min < CHECK_FROM) return { run: 'SKIP', reason: 'before ' + pad(CHECK_FROM / 60) + ':00' };
  var slot = null;
  c.times.forEach(function (s) { if (toMin(s) <= t.min) slot = s; });
  if (!slot) return { run: 'SKIP', reason: 'before the first check (' + c.times[0] + ')' };
  var late = t.min - toMin(slot);
  if (late >= LATE_MINUTES) {
    return { run: 'SKIP', reason: 'the ' + slot + ' check is ' + late + ' minutes late; a check is skipped once it is ' +
      LATE_MINUTES + ' minutes late' };
  }
  var s = load(dir);
  if (!s.baseline) return { run: 'SKIP', reason: 'no digest baseline yet; the next evening digest writes it' };
  if ((s.slots[t.date] || {})[slot]) return { run: 'SKIP', reason: 'the ' + slot + ' check already ran today' };
  return { run: 'CHECK', slot: slot, date: t.date, reason: 'check ' + slot };
}

/* ------------------------------------------------------------------ the message */

function shorten(s, n) {
  var t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1).replace(/[,;:\s]+\S*$/, '') + '…' : t;
}

function dueWords(e, today) {
  var l = e.item;
  if (l.status === 'overdue') return l.overdueDays + (l.overdueDays === 1 ? ' day late' : ' days late');
  if (l.status === 'due_today') return 'due today';
  return daysApart(today, l.workDue) === 1 ? 'due tomorrow' : 'due ' + l.workDue;
}

function line(e, today, labels, nameOf) {
  var l = e.item, who = l.who && (l.type === 'owed_to_us' || l.type === 'awaiting_reply' || l.type === 'unanswered_ask')
    ? (nameOf ? nameOf(l.who) : l.who) + ': ' : '';
  var where = /^#/.test(String(l.subject || '')) ? ' (' + l.subject + ')' : '';
  return '• ' + (labels[l.type] || l.type) + ' — ' + who + '"' + shorten(l.what, 96) + '"' + where + ' · ' + dueWords(e, today);
}

/* The alert, exactly as it is posted. Unnumbered and without a reference: there is nothing to
 * reply to, and the digest's numbering is not disturbed. */
function render(found, opts) {
  var labels = opts.labels || {}, shown = found.slice(0, MAX_ITEMS), n = found.length;
  var out = ['OPEN LOOPS ALERT — ' + opts.date + ' ' + opts.slot,
             n + (n === 1 ? ' thing' : ' things') + ' changed since your last digest.'];
  [['New and urgent', function (e) { return e.fresh; }],
   ['Now overdue', function (e) { return !e.fresh && e.level === 3; }],
   ['Now due today', function (e) { return !e.fresh && e.level === 2; }]].forEach(function (g) {
    var rows = shown.filter(g[1]);
    if (rows.length) out.push('', g[0]), rows.forEach(function (e) { out.push(line(e, opts.date, labels, opts.nameOf)); });
  });
  out.push('');
  if (n > shown.length) out.push('and ' + (n - shown.length) + ' more in tonight\'s digest.');
  var next = null;
  opts.times.forEach(function (s) { if (!next && s > opts.slot) next = s; });
  out.push((next ? 'Next check ' + next + '. ' : '') + 'Tonight\'s digest will number these; reply there to correct them.');
  return out.join('\n');
}

/* ------------------------------------------------------------------ a check */

/* Compare what the detector sees now with the last digest. Records what it found as pending;
 * `confirm` turns that into "alerted" once the message is really in the DM. A check that finds
 * nothing is complete at once. Returns the text to post, or null. */
function check(dir, cfg, o) {
  var c = consent(cfg);
  if (!c) throw new Error('alerts are off');
  if (c.times.indexOf(o.slot) === -1) throw new Error('"' + o.slot + '" is not one of the configured check times');
  var s = load(dir);
  if (!s.baseline) throw new Error('no digest baseline yet');
  var found = evaluate(o.open, s, o.today, o.verdictOf);
  if (!found.length) {
    (s.slots[o.date] = s.slots[o.date] || {})[o.slot] = o.stamp || new Date().toISOString();
    s.pending = null;
    save(dir, s);
    return null;
  }
  var text = render(found, { date: o.date, slot: o.slot, times: c.times, labels: o.labels || loops.LABEL, nameOf: o.nameOf });
  var shown = {};
  found.slice(0, MAX_ITEMS).forEach(function (e) { shown[e.key] = e.level; });
  s.pending = { date: o.date, slot: o.slot, alerts: shown };
  save(dir, s);
  return text;
}

/* The alert is in the DM: remember it, so no later check says it again, and the slot is done. */
function confirm(dir, stamp) {
  var s = load(dir);
  if (!s.baseline || !s.pending) return false;
  Object.keys(s.pending.alerts).forEach(function (k) {
    s.alerted[k] = Math.max(s.alerted[k] || 0, s.pending.alerts[k]);
  });
  (s.slots[s.pending.date] = s.slots[s.pending.date] || {})[s.pending.slot] = stamp || new Date().toISOString();
  s.pending = null;
  save(dir, s);
  return true;
}

module.exports = {
  DEFAULT_TIMES: DEFAULT_TIMES, LATE_MINUTES: LATE_MINUTES, MAX_ITEMS: MAX_ITEMS,
  consent: consent, level: level, evaluate: evaluate, decide: decide, render: render,
  check: check, confirm: confirm, writeBaseline: writeBaseline, stageBaseline: stageBaseline,
  promoteBaseline: promoteBaseline, baselineOf: baselineOf, stagedFile: stagedFile,
  load: load, save: save, file: file, baselineFile: baselineFile, parseNow: parseNow, localParts: localParts, addDays: addDays
};
