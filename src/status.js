/* "Is Open Loops working?" — what the last attempt did, kept apart from what was last delivered.
 *
 * Two records, never merged: `delivered` is written only when an attempt ends delivered, so a failed
 * attempt can never overwrite the last digest the reader actually got. `attempt` is written by every
 * real attempt. A preview (--dry) is not an attempt and leaves no record.
 *
 * status.json has one writer, tools/status.js. The runner only stages what a digest read into
 * status.staged.json (like alerts-baseline.next.json); an attempt that ends delivered promotes it,
 * by ref. Nothing here holds message text: dates, refs, channel names, counts, stage names.
 *
 * Delivered means all three of: the brief posted, the details posted, the brief read back correctly.
 * The details are not read back. Anything short of that is partial, not delivered — and when it is
 * not certain whether a post happened, the outcome is "unknown", never "nothing posted".
 */
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var retry = require('./busy.js').retry;

var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
var MAX_NAMES = 12;

function file(dir) { return path.join(dir, 'status.json'); }
function stagedFile(dir) { return path.join(dir, 'status.staged.json'); }

/* A failure to read or write the record says which it was, because what the caller may then claim differs:
 *   read      status.json could not be read: nothing was changed.
 *   write     the new version could not be written beside it: nothing was changed.
 *   uncertain the new version was written but could not be moved into place: the record may or may not have changed. */
function persistError(kind, e) { var x = new Error(e && e.message || String(e)); x.persist = kind; x.reason = e && e.code || (e && e.message) || String(e); return x; }

function writeJson(f, o) {
  var tmp = f + '.' + process.pid + '.' + crypto.randomBytes(3).toString('hex') + '.tmp';   // one name per write: two sessions never share one
  var drop = function () { try { fs.unlinkSync(tmp); } catch (ignore) { /* only this write's own file, and only if it is there */ } };
  try { fs.writeFileSync(tmp, JSON.stringify(o, null, 1)); } catch (e) { drop(); throw persistError('write', e); }
  try { retry(function () { fs.renameSync(tmp, f); }); } catch (e) { drop(); throw persistError('uncertain', e); }
}

// The staged file is the runner's and may be absent or torn: that reads as nothing there.
function readJson(f) {
  try { var s = JSON.parse(retry(function () { return fs.readFileSync(f, 'utf8'); })); return s && typeof s === 'object' ? s : {}; }
  catch (e) { return {}; }
}

var REF = /^[0-9a-f]{4}$/, ID = /^[0-9a-f]{8}$/, DATE = /^\d{4}-\d{2}-\d{2}$/;
function validDate(s) {
  if (typeof s !== 'string' || !DATE.test(s)) return false;
  var d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
function validIso(s) { return typeof s === 'string' && !isNaN(Date.parse(s)); }
function isObj(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }
function num(x) { return typeof x === 'number' && isFinite(x) ? x : null; }
function strs(a, n) { return Array.isArray(a) ? a.filter(function (x) { return typeof x === 'string'; }).slice(0, n) : []; }

/* Each record is checked on its own and kept only if it is whole and valid. A record that is not is dropped whole;
 * nothing is repaired by guessing. `dropped` counts entries thrown out of an otherwise valid record. */
var OUTCOMES = ['started', 'delivered', 'partial', 'not_delivered', 'unknown'];
function cleanSchedule(o) {
  if (!isObj(o) || typeof o.taskId !== 'string' || !o.taskId || typeof o.cron !== 'string' || !validDate(o.since)) return null;
  var state = o.state == null ? 'active' : o.state;
  if (['active', 'paused', 'deleted'].indexOf(state) < 0) return null;
  var off = [], dropped = 0;
  (Array.isArray(o.off) ? o.off : o.off == null ? [] : (dropped++, [])).forEach(function (x) {
    if (isObj(x) && validDate(x.from) && (x.to === null || validDate(x.to))) off.push({ from: x.from, to: x.to }); else dropped++;
  });
  var out = { taskId: o.taskId, cron: o.cron, since: o.since, state: state, off: off };
  if (validDate(o.deletedAt)) out.deletedAt = o.deletedAt;
  return { value: out, dropped: dropped };
}
function cleanDelivered(o) {
  if (!isObj(o) || !validDate(o.date) || !validIso(o.at) || !(o.ref === null || o.ref === undefined || REF.test(o.ref))) return null;
  var r = isObj(o.read) && ['complete', 'incomplete', 'nothing', 'unknown'].indexOf(o.read.state) > -1 ? o.read : { state: 'unknown', why: [] };
  return { value: { date: o.date, at: o.at, ref: o.ref || null, read: { state: r.state, why: strs(r.why, 6) }, channels: strs(o.channels, 12),
    conversations: num(o.conversations), messages: num(o.messages), meetings: num(o.meetings), windowDays: num(o.windowDays) }, dropped: 0 };
}
function cleanAttempt(o) {
  if (!isObj(o) || !ID.test(o.id) || !validDate(o.date) || !validIso(o.startedAt) || OUTCOMES.indexOf(o.outcome) < 0) return null;
  var inSet = function (v, set) { return set.indexOf(v) > -1 ? v : undefined; };
  var facts = ['posted', 'rejected', 'not_attempted', 'unknown'];
  return { value: { id: o.id, date: o.date, startedAt: o.startedAt, outcome: o.outcome,
    cause: inSet(o.cause, ['details', 'verify', 'fetch', 'build', 'post', 'config', 'ledger']) || null,
    fetched: typeof o.fetched === 'boolean' ? o.fetched : undefined, endedAt: validIso(o.endedAt) ? o.endedAt : undefined,
    brief: inSet(o.brief, facts), details: inSet(o.details, facts), verified: o.verified === true,
    ref: REF.test(o.ref) ? o.ref : null, notice: inSet(o.notice, ['none', 'pending', 'posted', 'rejected', 'unknown', 'not_attempted']) }, dropped: 0 };
}
/* Attempts that began and were replaced by a later --begin before they ended, so their --end can still say what happened. */
function cleanSuperseded(a) {
  return (Array.isArray(a) ? a : []).filter(function (x) { return isObj(x) && ID.test(x.id) && validDate(x.date) && validIso(x.startedAt); })
    .map(function (x) { return { id: x.id, date: x.date, startedAt: x.startedAt }; }).slice(-3);
}

function cleanNote(o) {
  return isObj(o) && typeof o.file === 'string' && /^status\.json\.damaged-[0-9T-]+-[0-9a-f]{8}(?:-\d+)?$/.test(o.file)
    ? { file: o.file, recovered: strs(o.recovered, 3), lost: strs(o.lost, 3) } : null;
}
var SECTIONS = [['schedule', 'schedule', cleanSchedule], ['delivered', 'last delivered digest', cleanDelivered], ['attempt', 'last attempt', cleanAttempt]];

/* The one balanced {...} that follows "key": — or null when it does not close. A truncated record never does, and is
 * not completed by guessing what the rest might have said. */
function extractObject(text, key) {
  var m = new RegExp('"' + key + '"\\s*:\\s*\\{').exec(text);
  if (!m) return null;
  var depth = 0, inStr = false, esc = false;
  for (var i = m.index + m[0].length - 1; i < text.length; i++) {
    var c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(m.index + m[0].length - 1, i + 1);
  }
  return null;
}

/* The record as it can be trusted. Missing file: empty, not damaged. Anything else that is not whole — unreadable JSON,
 * a truncated file, a record that fails its checks — is `damaged`, with what was recovered and what was not. Reading
 * never writes; the damaged file is preserved by save() before anything replaces it. */
function load(dir) {
  var text = null;
  try { text = retry(function () { return fs.readFileSync(file(dir), 'utf8'); }); }
  catch (e) { if (e.code !== 'ENOENT') throw persistError('read', e); }
  var out = { schedule: null, attempt: null, delivered: null, note: null, damaged: null, superseded: [] };
  if (text === null) return out;
  var root = null;
  try { var parsed = JSON.parse(text); if (isObj(parsed)) root = parsed; } catch (e) { root = null; }
  var recovered = [], lost = [], damaged = root === null;
  SECTIONS.forEach(function (sec) {
    var raw = null;
    if (root) raw = root[sec[0]];
    else { var piece = extractObject(text, sec[0]); try { raw = piece === null ? undefined : JSON.parse(piece); } catch (e) { raw = undefined; } }
    if (raw === undefined && root) raw = null;
    if (raw === null) { if (!root) lost.push(sec[1]); return; }
    var c = raw === undefined ? null : sec[2](raw);
    if (!c) { lost.push(sec[1]); damaged = true; return; }
    out[sec[0]] = c.value; recovered.push(sec[1]);
    if (c.dropped) damaged = true;
  });
  if (root) { out.note = cleanNote(root.note); out.superseded = cleanSuperseded(root.superseded); }
  if (damaged) out.damaged = { recovered: recovered, lost: lost };
  return out;
}

/* The damaged file, kept whole under a name that cannot collide with an earlier one. */
function preserve(dir, now) {
  var d = now || new Date(), stamp = localDate(d).split('-').join('') + 'T' + pad(d.getHours()) + pad(d.getMinutes());
  for (var i = 0; i < 20; i++) {
    var name = 'status.json.damaged-' + stamp + '-' + crypto.randomBytes(4).toString('hex');
    try { fs.copyFileSync(file(dir), path.join(dir, name), fs.constants.COPYFILE_EXCL); return name; }
    catch (e) { if (e.code !== 'EEXIST') throw persistError('write', e); }
  }
  throw new Error('could not find an unused name to preserve the damaged status record under');
}

/* Every write goes through here. A record that was damaged when read is preserved first, then replaced by what was
 * recovered, with a note saying so. */
function save(dir, s, now) {
  var note = s.note || null;
  if (s.damaged) note = { file: preserve(dir, now), recovered: s.damaged.recovered, lost: s.damaged.lost };
  writeJson(file(dir), { schedule: s.schedule, attempt: s.attempt, delivered: s.delivered, note: note, superseded: s.superseded && s.superseded.length ? s.superseded : undefined });
}

/* Brings a damaged record into a whole one (preserving the original) and returns it. */
function repair(dir, now) { var s = load(dir); if (s.damaged) save(dir, s, now); return load(dir); }

/* ------------------------------------------------------------------ dates */

function pad(n) { return (n < 10 ? '0' : '') + n; }
function localDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function parseNow(s) {
  var m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : new Date();
}
function addDays(date, n) { return new Date(new Date(date + 'T00:00:00Z').getTime() + n * 864e5).toISOString().slice(0, 10); }
function dowOf(date) { return new Date(date + 'T00:00:00Z').getUTCDay(); }
function dayName(date) { return DOW[dowOf(date)] + ' ' + date.slice(5); }
function clock(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }

/* ------------------------------------------------------------------ the schedule */

/* Which weekdays a five-field cron runs on — or null when it is not a plain "at a time, on these
 * days" schedule. Null means unknown, and unknown never counts a day as missed. */
function cronDays(cron) {
  var f = String(cron || '').trim().split(/\s+/);
  if (f.length !== 5) return null;
  if (!/^\d{1,2}$/.test(f[0]) || !/^\d{1,2}$/.test(f[1]) || f[2] !== '*' || f[3] !== '*') return null;
  var days = {}, ok = true;
  if (f[4] === '*') return [0, 1, 2, 3, 4, 5, 6];
  f[4].split(',').forEach(function (part) {
    var m = part.match(/^([0-7])(?:-([0-7]))?$/);
    if (!m) { ok = false; return; }
    var a = +m[1], b = m[2] == null ? a : +m[2];
    if (b < a) { ok = false; return; }
    for (var d = a; d <= b; d++) days[d % 7] = 1;
  });
  return ok ? Object.keys(days).map(Number).sort() : null;
}
function describeCron(cron) {
  var d = cronDays(cron);
  if (!d) return null;
  if (d.length === 7) return 'every day';
  if (d.join() === '1,2,3,4,5') return 'weekdays';
  return 'on ' + d.map(function (x) { return DOW[x]; }).join(', ');
}

/* The task that runs the digest, and when. `since` is the day it started counting, so days before
 * a schedule existed are never "missed", and refreshing the same schedule does not move it. `state` and `off`
 * say when it was paused: a day the task was off is not a missed day. Refreshing keeps them; a different task
 * starts clean. */
function setSchedule(dir, taskId, cron, now) {
  var s = load(dir), today = localDate(now || new Date()), old = s.schedule;
  var sameTask = !!old && old.taskId === taskId && old.state !== 'deleted';
  var since = sameTask && old.cron === cron && old.since ? old.since : today;
  s.schedule = { taskId: taskId, cron: cron, since: since, state: sameTask ? old.state || 'active' : 'active',
    off: sameTask && Array.isArray(old.off) ? old.off.filter(function (o) { return o.to == null || o.to >= since; }) : [] };
  save(dir, s);
  return s.schedule;
}

/* The digest task was paused, resumed or deleted. Paused stretches are kept as days, both ends inclusive, so a
 * day the task may or may not have run on is never called missed. Idempotent: pausing a paused task adds nothing. */
function setScheduleState(dir, state, now) {
  var s = load(dir), sc = s.schedule, today = localDate(now || new Date());
  if (!sc) throw new Error('no digest task is recorded: run --schedule first');
  var off = Array.isArray(sc.off) ? sc.off : [];
  if (state === 'paused') {
    if (sc.state !== 'paused' && sc.state !== 'deleted') off.push({ from: today, to: null });
    if (sc.state !== 'deleted') sc.state = 'paused';
  } else if (state === 'resumed') {
    if (sc.state === 'paused') {
      var last = off[off.length - 1];
      if (last && last.to == null) last.to = today;
      sc.state = 'active';
    }
  } else if (state === 'deleted') {
    sc.state = 'deleted'; sc.deletedAt = today;
  } else throw new Error('--schedule-state must be paused, resumed or deleted');
  sc.off = off;
  save(dir, s);
  return sc;
}

/* Days the schedule expected a digest that did not come: strictly between the last delivered digest
 * and today, on the schedule's days, only after the schedule began, and never while the task was paused. Only after a gap; with no
 * recorded schedule, or one this cannot read, there are no expected days and so no gap. */
function gap(dir, today) {
  try { return gapOf(dir, today); } catch (e) { return null; }   // the record must never cost a digest
}
function gapOf(dir, today) {
  var s = load(dir);
  if (!s.delivered || !s.delivered.date || !s.schedule || s.schedule.state === 'deleted') return null;
  var days = cronDays(s.schedule.cron), prev = s.delivered.date, off = Array.isArray(s.schedule.off) ? s.schedule.off : [];
  if (!days || prev >= today) return null;
  var missed = [];
  for (var d = addDays(prev, 1); d < today; d = addDays(d, 1)) {
    var paused = off.some(function (o) { return o.from <= d && (o.to == null || d <= o.to); });
    if (d > (s.schedule.since || '0') && !paused && days.indexOf(dowOf(d)) > -1) missed.push(d);
  }
  return missed.length ? { prev: prev, missed: missed } : null;
}

/* The brief's one line, only after a gap. */
function gapLine(g) {
  if (!g) return null;
  var shown = g.missed.slice(0, 3).map(dayName).join(', ');
  return 'Previous digest: ' + dayName(g.prev) + ' · none on ' + shown +
    (g.missed.length > 3 ? ' and ' + (g.missed.length - 3) + ' more' : '') + '.';
}

/* ------------------------------------------------------------------ what a run read */

/* Same rule as digest.prep for "read nothing": conversations handed over and none parsed, or none handed over. */
function readFacts(read, messageCount) {
  read = read || {};
  var none = !messageCount && ((read.threads > 0 && read.confirmedEmpty !== read.threads) || read.threads === 0);
  var why = [];
  (read.shortRead || []).forEach(function (x) {
    why.push(x.channel + (x.reason ? ': ' + x.reason : ' was not read back to the start of the window'));
  });
  if (!(read.shortRead || []).length && read.capped) why.push('stopped at a read limit');
  (read.failed || []).forEach(function (l) { why.push(l + ' could not be parsed'); });
  if (!none && (read.unread || []).length) why.push('nothing came back from ' + read.unread.join(', '));
  if (read.unfetchedThreads) why.push(read.unfetchedThreads + (read.unfetchedThreads === 1 ? ' thread' : ' threads') + ' had replies that were not read');
  if (read.calendarError) why.push('the calendar could not be read');
  return { state: none ? 'nothing' : why.length ? 'incomplete' : 'complete', why: why.slice(0, 6) };
}

/* The runner's, for a digest that has not been posted yet. */
function stage(dir, o) {
  writeJson(stagedFile(dir), {
    ref: o.ref, date: o.date, read: o.read, channels: (o.channels || []).slice(0, MAX_NAMES),
    conversations: o.conversations, messages: o.messages, meetings: o.meetings,
    windowDays: o.windowDays || null
  });
}

/* ------------------------------------------------------------------ attempts */

/* What can be said about a post. Not finding a message proves nothing — it may have gone out with a damaged header, or be
 * in flight after a timeout — so there is no word for "it was not there". `posted` is a timestamp from Slack or a message
 * positively identified; `rejected` is Slack explicitly refusing it; `not_attempted` is a run that stopped before trying;
 * everything else is `unknown`. */
var BRIEF = ['posted', 'rejected', 'not_attempted', 'unknown'], DETAILS = BRIEF;
var NOT_A_FACT = ['not_posted', 'na', 'absent', 'not_found'];
var FAILED = ['', 'config', 'ledger', 'fetch', 'build', 'post', 'verify'];
var STOPPED_BEFORE_POSTING = ['config', 'ledger', 'fetch', 'build'];

function begin(dir, today, now) {
  if (today != null && !validDate(today)) throw new Error('--today must be a real date like 2026-09-30, got "' + today + '". Nothing was recorded.');
  var s = load(dir), id = crypto.randomBytes(4).toString('hex');
  /* A run that began and never ended (it crashed, or a second run began over it) is kept, not erased: its own --end can still report. */
  if (s.attempt && s.attempt.outcome === 'started') s.superseded = (s.superseded || []).concat([{ id: s.attempt.id, date: s.attempt.date, startedAt: s.attempt.startedAt }]).slice(-3);
  s.attempt = { id: id, date: today || localDate(now || new Date()), startedAt: (now || new Date()).toISOString(), outcome: 'started' };
  save(dir, s);
  return id;
}

/* What the facts add up to. A post whose outcome is uncertain is "unknown": it does not become
 * "nothing posted", and it is not a reason to retry. Facts that contradict each other are unknown too. */
function classify(f) {
  if (f.brief === 'unknown' || f.details === 'unknown') return { outcome: 'unknown' };
  if (f.brief === 'posted') {
    if (f.details === 'posted' && f.verified) return { outcome: 'delivered' };
    return { outcome: 'partial', cause: f.details === 'posted' ? 'verify' : 'details' };
  }
  if (f.details === 'posted') return { outcome: 'unknown' };
  // A refused post was a post attempt, whatever stage the assistant named.
  return { outcome: 'not_delivered', cause: f.brief === 'not_attempted' && STOPPED_BEFORE_POSTING.indexOf(f.failed) > -1 ? f.failed : 'post' };
}

function lastDelivered(d) {
  if (d && d.unreadable) return 'Last delivered digest: not known — the status record could not be read.';
  return d && d.date ? 'Last delivered digest: ' + DOW[dowOf(d.date)] + ' ' + d.date + (d.ref ? ' · ref ' + d.ref + ' (search this DM for that ref)' : '') + '.'
                     : 'No verified delivery recorded by status tracking yet.';
}
var RETRY = 'To try again now, tell your assistant "run Open Loops". That posts a fresh digest for today.';
var EMPTY = 'An empty DM today does not mean nothing is outstanding.';
var NO_RETRY = 'Running it again will not help until ';

/* The notice, stage by stage, saying only what is true at that stage. `where` is where it is posted. */
var STAGES = ['config', 'ledger', 'fetch', 'build', 'post'];
function notice(a, delivered) {
  var d = a.date, last = lastDelivered(delivered), t;
  // Nothing recorded says where it stopped (an older or damaged record): it is not told as "built, but could not be posted".
  if (a.outcome === 'not_delivered' && STAGES.indexOf(a.cause) < 0) a = Object.assign({}, a, { outcome: 'unknown' });
  if (a.outcome === 'not_delivered' && (a.cause === 'config' || a.cause === 'ledger')) {
    /* What was fetched is what the run recorded, never inferred from the stage: a configuration found unusable after Slack was read did fetch. */
    var why = a.cause === 'ledger'
      ? 'Slack was fetched, but the ledger file can\'t be read, so today\'s digest was not built. Nothing was posted, and the ledger was left exactly as it is. ' +
        NO_RETRY + 'the ledger is restored — tell your assistant "check the Open Loops ledger".'
      : (a.fetched ? 'Slack was fetched, but Open Loops\' configuration can\'t be used, so today\'s digest was not built. Nothing was posted. '
                   : 'Open Loops\' configuration can\'t be used, so nothing was fetched and nothing was posted. ') +
        NO_RETRY + 'the configuration is fixed — tell your assistant "fix the Open Loops configuration".';
    return { where: 'dm', text: ['OPEN LOOPS NOT RUN — for ' + d, why + ' ' + EMPTY, last].join('\n') };
  }
  if (a.outcome === 'not_delivered') {
    var what = a.cause === 'fetch' ? 'Open Loops could not fetch Slack for today\'s digest, so nothing was checked and nothing was posted.'
      : a.cause === 'build' ? 'Slack was fetched, but processing failed, so today\'s digest was not built. Nothing was posted.'
      : 'Today\'s digest was built, but it could not be posted. Nothing was posted.';
    t = ['OPEN LOOPS NOT RUN — for ' + d, what + ' ' + EMPTY, last, RETRY];
    return { where: 'dm', text: t.join('\n') };
  }
  if (a.outcome === 'partial') {
    var line = a.cause === 'details'
      ? 'The brief posted, but the full details are unavailable: the details message did not post. The full list, the sentences and any drafts are not here.'
      : (a.details === 'posted' ? 'The brief and details posted, but' : 'The brief posted and the full details are unavailable, and') +
        ' the brief did not read back as expected, so it may be malformed, and replies to it may not be recognised.';
    return { where: 'thread', text: ['OPEN LOOPS NOTES — for ' + d, line, RETRY].join('\n') };
  }
  t = ['OPEN LOOPS DELIVERY UNKNOWN — for ' + d,
    'Open Loops could not confirm whether today\'s digest posted. Check this DM before running it again: it may already be here.',
    last, 'If it is not, tell your assistant "run Open Loops".'];
  return { where: 'dm', text: t.join('\n') };
}

/* The facts of an ended run, checked. Nothing is recorded by a refusal. */
function checkFacts(o) {
  var f = { brief: o.brief, details: o.details, verified: o.verified === true, failed: o.failed || '' };
  if (NOT_A_FACT.indexOf(f.brief) > -1 || NOT_A_FACT.indexOf(f.details) > -1) {
    throw new Error('"' + (NOT_A_FACT.indexOf(f.brief) > -1 ? f.brief : f.details) + '" is not something that can be reported: absence proves nothing. ' +
      'Use rejected (Slack explicitly refused the post), not_attempted (the run stopped before trying) or unknown.');
  }
  if (BRIEF.indexOf(f.brief) < 0) throw new Error('--brief must be one of ' + BRIEF.join(', '));
  if (DETAILS.indexOf(f.details) < 0) throw new Error('--details must be one of ' + DETAILS.join(', '));
  if (FAILED.indexOf(f.failed) < 0) throw new Error('--failed must be one of ' + FAILED.filter(Boolean).join(', '));
  if (f.brief === 'not_attempted' && STOPPED_BEFORE_POSTING.indexOf(f.failed) < 0) {
    throw new Error('--brief not_attempted only fits a run that stopped before posting (--failed ' + STOPPED_BEFORE_POSTING.join(', ') + '); a post that was tried and did not land is rejected or unknown');
  }
  if (STOPPED_BEFORE_POSTING.indexOf(f.failed) > -1 && (f.brief !== 'not_attempted' || f.details !== 'not_attempted')) {
    throw new Error('--failed ' + f.failed + ' means the run stopped before posting, so --brief and --details must be not_attempted, got ' + f.brief + '/' + f.details + '. Nothing was recorded.');
  }
  if (o.fetched != null && f.failed !== 'config') throw new Error('--fetched only goes with --failed config. Nothing was recorded.');
  if (f.failed === 'config' && o.fetched !== 'yes' && o.fetched !== 'no') {
    throw new Error('--failed config needs --fetched yes|no: whether Slack had already been fetched when the configuration was found unusable. Nothing was recorded.');
  }
  var c = classify(f);
  if (f.failed === 'verify' && f.verified) throw new Error('--failed verify means the read-back failed, so --verified must be no. Nothing was recorded.');
  if (f.failed === 'post' && c.outcome === 'delivered') throw new Error('--failed post means a post did not land, but --brief and --details are both posted and verified. Nothing was recorded.');
  return { f: f, c: c };
}

/* Ends an attempt from the facts. Returns the notice to post, or null when there is none to issue.
 * A second call for the same attempt issues nothing: one notice per failed attempt. */
function end(dir, o, now) {
  var s = load(dir);
  var current = !!(s.attempt && s.attempt.id === o.id), sup = current ? null : (s.superseded || []).filter(function (x) { return x.id === o.id; })[0];
  if (!current && !sup) throw new Error('no attempt ' + o.id + ' is open: run --begin first, and use the id it printed');
  // A replaced attempt is ended on its own copy: it never becomes the last attempt, but its notice, or its delivery, is not lost.
  var a = current ? s.attempt : { id: sup.id, date: sup.date, startedAt: sup.startedAt, outcome: 'started' };
  if (a.outcome !== 'started') return { outcome: a.outcome, done: true, notice: null };
  var fc = checkFacts(o), f = fc.f, c = fc.c, at = (now || new Date()).toISOString();
  if (o.ref != null && o.ref !== '' && !REF.test(o.ref)) throw new Error('--ref must be the four-character reference in the digest\'s header, got "' + o.ref + '". Nothing was recorded.');
  if (c.outcome === 'delivered' && !o.ref) throw new Error('A delivered digest needs --ref, the four-character reference in its header. Nothing was recorded.');
  a.outcome = c.outcome; a.cause = c.cause || null; a.endedAt = at;
  a.brief = f.brief; a.details = f.details; a.verified = f.verified; a.ref = o.ref || null;
  if (c.cause === 'config') a.fetched = o.fetched === 'yes';
  if (c.cause === 'ledger') a.fetched = true;    // the ledger is read only after Slack was fetched
  if (c.outcome === 'delivered') {
    var st = readJson(stagedFile(dir)), ok = o.ref && st.ref === o.ref;
    s.delivered = { date: a.date, at: at, ref: o.ref || null,
      read: ok ? st.read : { state: 'unknown', why: [] },
      channels: ok ? st.channels || [] : [], conversations: ok ? st.conversations : null,
      messages: ok ? st.messages : null, meetings: ok ? st.meetings : null, windowDays: ok ? st.windowDays : null };
    a.notice = 'none';
    s.note = null;
    if (sup) s.superseded = s.superseded.filter(function (x) { return x.id !== o.id; });
    try { save(dir, s, now); } catch (e) { if (e.persist) e.result = { outcome: 'delivered', notice: null }; throw e; }
    return { outcome: 'delivered', done: false, notice: null, superseded: !!sup };
  }
  var n = notice(a, s.delivered);
  a.notice = 'pending';
  if (sup) s.superseded = s.superseded.filter(function (x) { return x.id !== o.id; });
  try { save(dir, s); } catch (e) { if (e.persist) e.result = { outcome: c.outcome, notice: n }; throw e; }
  return { outcome: c.outcome, done: false, notice: n, superseded: !!sup };
}

/* An attempt whose --begin could not save a record, or whose record cannot be read now: the notice is still made, from the facts of this run alone.
 * Nothing is recorded, and the result says so. */
function endUnrecorded(dir, o) {
  if (!validDate(o.today)) throw new Error('--today must be a real date like 2026-09-30 for an attempt that has no record. Nothing was recorded.');
  var fc = checkFacts(o), f = fc.f, c = fc.c;
  if (o.ref != null && o.ref !== '' && !REF.test(o.ref)) throw new Error('--ref must be the four-character reference in the digest\'s header, got "' + o.ref + '". Nothing was recorded.');
  if (c.outcome === 'delivered') {
    if (!o.ref) throw new Error('A delivered digest needs --ref, the four-character reference in its header. Nothing was recorded.');
    return { outcome: 'delivered', done: false, notice: null, unrecorded: true };
  }
  var delivered;
  try { delivered = load(dir).delivered; } catch (e) { delivered = { unreadable: true }; }
  var a = { id: 'UNRECORDED', date: o.today, outcome: c.outcome, cause: c.cause || null, brief: f.brief, details: f.details, verified: f.verified, ref: o.ref || null };
  if (c.cause === 'config') a.fetched = o.fetched === 'yes';
  if (c.cause === 'ledger') a.fetched = true;
  return { outcome: c.outcome, done: false, notice: notice(a, delivered), unrecorded: true };
}

/* Only Slack's confirmation makes a notice "posted". Until this is called it is "pending": generated, not delivered. */
function noticeResult(dir, id, result) {
  var s = load(dir), a = s.attempt;
  if (!a || a.id !== id) throw new Error('no attempt ' + id + ' is open');
  if (a.notice !== 'pending') throw new Error('attempt ' + id + ' has no notice waiting on a result');
  if (['posted', 'rejected', 'unknown', 'not_attempted'].indexOf(result) < 0) throw new Error('--notice-result must be posted (Slack returned a timestamp), rejected (Slack explicitly refused it), not_attempted (no DM to post it in could be found) or unknown');
  a.notice = result;
  save(dir, s);
}

/* ------------------------------------------------------------------ the view */

var DM_NAME = /^(dm with |dm:|group dm|mpdm-)/i;

function nameList(list) { return list.length ? list.join('  ') : null; }

function readLine(d) {
  var r = d.read || {}, n = function (x, w) { return x + ' ' + w + (x === 1 ? '' : 's'); };
  var size = (d.channels && d.channels.length ? n(d.conversations != null ? d.conversations : d.channels.length, 'conversation') : null);
  if (r.state === 'complete') {
    return 'read in full: ' + [size, d.meetings != null ? n(d.meetings, 'meeting') : null,
      d.windowDays ? d.windowDays + ' days back' : null].filter(Boolean).join(', ');
  }
  if (r.state === 'incomplete') return 'the read was incomplete: ' + (r.why || []).join('; ') + '. Details are in the digest\'s thread.';
  if (r.state === 'nothing') return 'nothing could be read from the conversations it was handed. An empty list that day meant unknown, not clear.';
  return 'how completely it read was not recorded';
}

function stamp(iso) {
  var d = new Date(iso);
  return DOW[d.getDay()] + ' ' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ', ' + clock(d);
}

function attemptLine(a, delivered) {
  if (!a) return 'none recorded';
  var when = stamp(a.startedAt);
  if (a.outcome === 'delivered') return delivered && a.endedAt && a.endedAt === delivered.at ? 'the same one' : when + ' — delivered';
  var note = { pending: 'A notice was generated but not confirmed posted.', posted: 'A notice was posted to your DM.',
               rejected: 'Slack rejected the notice, so it was not posted.', unknown: 'Whether the notice posted is unknown.',
               not_attempted: 'No notice was posted: your own DM could not be found to post it in.' }[a.notice] || '';
  var ref = a.ref ? ' (ref ' + a.ref + ')' : '';
  if (a.outcome === 'not_delivered' && STAGES.indexOf(a.cause) < 0) a = Object.assign({}, a, { outcome: 'unknown' });
  var body = a.outcome === 'started'
    ? 'started; no completion recorded. It may still be running or may have been interrupted; its delivery outcome is unknown.'
    : a.outcome === 'unknown'
      ? 'delivery unknown: Open Loops could not confirm whether the digest posted. Check your DM before running it again.'
      : a.outcome === 'partial'
        ? (a.cause === 'details' ? 'partly delivered' + ref + ': the brief posted, but the full details are unavailable.'
          : (a.details === 'posted' ? 'brief and details posted' : 'the brief posted and the full details are unavailable') +
            ' (brief not verified)' + ref + ': it did not read back as expected, so it may be malformed, and replies to it may not be recognised.')
        : a.cause === 'ledger' ? 'Slack was fetched, but the ledger file can\'t be read. Nothing was posted.'
        : a.cause === 'config' ? (a.fetched === true ? 'Slack was fetched, but the configuration can\'t be used. Nothing was posted.' : a.fetched === false ? 'the configuration can\'t be used. Nothing was fetched or posted.' : 'the configuration can\'t be used. Nothing was posted.')
        : a.cause === 'fetch' ? 'Slack could not be fetched. Nothing was posted.'
        : a.cause === 'build' ? 'Slack was fetched, but processing failed. Nothing was posted.'
        : 'the digest was built, but posting failed. Nothing was posted.';
  return when + ' — ' + body + (note ? '\n' + note : '');
}

/* The scheduler is the host's. `sched` is what it said — { next: ISO } or { paused: true } — or nothing,
 * and nothing is "unknown": no time is inferred from a cron. */
function view(dir, cfg, sched, now, scope) {
  now = now || new Date();
  var s = load(dir), today = localDate(now), out = [];
  var L = function (label, text) {
    String(text).split('\n').forEach(function (line, i) { out.push((i ? '                        ' : (label + '                        ').slice(0, 24)) + line); });
  };
  out.push('OPEN LOOPS — status · ' + DOW[now.getDay()] + ' ' + today);
  out.push('');
  if (s.damaged && scope && scope.readOnly) {
    L('Status record', 'Status record is damaged. Read-only mode left it unchanged; displayed history includes only validated records.');
  } else if (s.note) {
    L('Status record', 'damaged: kept as ' + s.note.file + '.\nRecovered: ' + (s.note.recovered.length ? s.note.recovered.join(', ') : 'nothing') + '.' +
      (s.note.lost.length && s.note.recovered.length ? ' Not recovered: ' + s.note.lost.join(', ') + '.' : ''));
  }
  var dv = s.delivered;
  if (dv) {
    L('Last delivered digest', stamp(dv.at) + (dv.ref ? ' · ref ' + dv.ref : ' · ref not recorded') + '\nbrief and details posted; brief verified\n' + readLine(dv));
  } else L('Last delivered digest', 'No verified delivery recorded by status tracking yet');
  L('Last attempt', attemptLine(s.attempt, dv));
  (s.superseded || []).forEach(function (x) {
    var d = new Date(x.startedAt);
    L('', 'An earlier attempt (' + DOW[d.getDay()] + ' ' + clock(d) + ') started and was replaced by a later one before reporting an outcome.');
  });
  var g = gap(dir, today);
  if (g) L('', 'No digest since ' + dayName(g.prev) + '; the schedule expected one on ' + g.missed.map(dayName).join(', ') + '.');

  var next = 'unknown — the scheduler could not be read. Check the scheduled tasks in your app.';
  if (sched && sched.paused) next = 'paused — nothing will run until you resume it.';
  else if (sched && sched.next && !isNaN(new Date(sched.next))) {
    var nx = new Date(sched.next), nd = localDate(nx);
    var day = nd === today ? 'today' : nd === addDays(today, 1) ? 'tomorrow' : DOW[nx.getDay()] + ' ' + nd.slice(5);
    var how = s.schedule && describeCron(s.schedule.cron);
    next = day + ', about ' + clock(nx) + (how ? ' (' + how + ', your local time)' : ' (your local time)');
  }
  if (!sched && s.schedule && s.schedule.state === 'deleted') next = 'none — the digest task was deleted' + (s.schedule.deletedAt ? ' on ' + s.schedule.deletedAt : '') + '.';
  L('Next run', next);

  var inc = (cfg.channels && cfg.channels.include) || [], exc = (cfg.channels && cfg.channels.exclude) || [];
  var chans = inc.filter(function (x) { return !DM_NAME.test(x); }), dms = inc.filter(function (x) { return DM_NAME.test(x); });
  L('Tracking', nameList(chans) || (dms.length ? 'no channels' : 'every channel it is handed (no include list is set)'));
  var xs = exc.filter(function (x) { return !DM_NAME.test(x); });
  if (xs.length) L('Not tracking', nameList(xs) + ' (excluded)');
  L('Direct messages', 'your own DM (the digest and your replies)' +
    (dms.length ? '; also ' + dms.join(', ') + ' (named in your config)' : '; no others are named in your config, so none are read'));
  var extra = [scope && scope.alerts ? 'Midday alerts on' : 'Midday alerts off',
               scope && scope.diagnostics ? 'Diagnostic reports on' : 'Diagnostic reports off'];
  out.push(extra.join(' · '));
  out.push('');
  out.push('It only runs while the app is open and your computer is awake at that time.');
  out.push('To change it, just say: "add #sales" · "stop reading #exec-team" ·');
  out.push('"send it at 7pm" · "pause it" · "stop Open Loops"');
  out.push('Stopping deletes the schedule and keeps your ledger.');
  return out.join('\n');
}

module.exports = {
  endUnrecorded: endUnrecorded, load: load, repair: repair, validDate: validDate, begin: begin, end: end, noticeResult: noticeResult, classify: classify, notice: notice,
  setSchedule: setSchedule, setScheduleState: setScheduleState, gap: gap, gapLine: gapLine, cronDays: cronDays, describeCron: describeCron,
  readFacts: readFacts, stage: stage, view: view, parseNow: parseNow, localDate: localDate,
  file: file, stagedFile: stagedFile
};
