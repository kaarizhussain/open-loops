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

// A missing or torn file reads as "nothing there", never as half a record.
function readJson(f) {
  try { var s = JSON.parse(retry(function () { return fs.readFileSync(f, 'utf8'); })); return s && typeof s === 'object' ? s : {}; }
  catch (e) { return {}; }
}
function writeJson(f, o) {
  var tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(o, null, 1));
  retry(function () { fs.renameSync(tmp, f); });
}

function load(dir) {
  var s = readJson(file(dir));
  return { schedule: s.schedule && typeof s.schedule === 'object' ? s.schedule : null,
           attempt: s.attempt && typeof s.attempt === 'object' ? s.attempt : null,
           delivered: s.delivered && typeof s.delivered === 'object' ? s.delivered : null };
}
function save(dir, s) { writeJson(file(dir), { schedule: s.schedule, attempt: s.attempt, delivered: s.delivered }); }

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
var FAILED = ['', 'fetch', 'build', 'post', 'verify'];

function begin(dir, today, now) {
  var s = load(dir), id = crypto.randomBytes(4).toString('hex');
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
  return { outcome: 'not_delivered', cause: f.brief === 'not_attempted' && (f.failed === 'fetch' || f.failed === 'build') ? f.failed : 'post' };
}

function lastDelivered(d) {
  return d && d.date ? 'Last delivered digest: ' + DOW[dowOf(d.date)] + ' ' + d.date + (d.ref ? ' · ref ' + d.ref + ' (search this DM for that ref)' : '') + '.'
                     : 'No verified delivery recorded by status tracking yet.';
}
var RETRY = 'To try again now, tell your assistant "run Open Loops". That posts a fresh digest for today.';
var EMPTY = 'An empty DM today does not mean nothing is outstanding.';

/* The notice, stage by stage, saying only what is true at that stage. `where` is where it is posted. */
function notice(a, delivered) {
  var d = a.date, last = lastDelivered(delivered), t;
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

/* Ends an attempt from the facts. Returns the notice to post, or null when there is none to issue.
 * A second call for the same attempt issues nothing: one notice per failed attempt. */
function end(dir, o, now) {
  var s = load(dir), a = s.attempt;
  if (!a || a.id !== o.id) throw new Error('no attempt ' + o.id + ' is open: run --begin first, and use the id it printed');
  if (a.outcome !== 'started') return { outcome: a.outcome, done: true, notice: null };
  var f = { brief: o.brief, details: o.details, verified: o.verified === true, failed: o.failed || '' };
  if (NOT_A_FACT.indexOf(f.brief) > -1 || NOT_A_FACT.indexOf(f.details) > -1) {
    throw new Error('"' + (NOT_A_FACT.indexOf(f.brief) > -1 ? f.brief : f.details) + '" is not something that can be reported: absence proves nothing. ' +
      'Use rejected (Slack explicitly refused the post), not_attempted (the run stopped before trying) or unknown.');
  }
  if (BRIEF.indexOf(f.brief) < 0) throw new Error('--brief must be one of ' + BRIEF.join(', '));
  if (DETAILS.indexOf(f.details) < 0) throw new Error('--details must be one of ' + DETAILS.join(', '));
  if (FAILED.indexOf(f.failed) < 0) throw new Error('--failed must be one of ' + FAILED.filter(Boolean).join(', '));
  if (f.brief === 'not_attempted' && f.failed !== 'fetch' && f.failed !== 'build') {
    throw new Error('--brief not_attempted only fits a run that stopped before posting (--failed fetch or build); a post that was tried and did not land is rejected or unknown');
  }
  var c = classify(f), at = (now || new Date()).toISOString();
  a.outcome = c.outcome; a.cause = c.cause || null; a.endedAt = at;
  a.brief = f.brief; a.details = f.details; a.verified = f.verified; a.ref = o.ref || null;
  if (c.outcome === 'delivered') {
    var st = readJson(stagedFile(dir)), ok = o.ref && st.ref === o.ref;
    s.delivered = { date: a.date, at: at, ref: o.ref || null,
      read: ok ? st.read : { state: 'unknown', why: [] },
      channels: ok ? st.channels || [] : [], conversations: ok ? st.conversations : null,
      messages: ok ? st.messages : null, meetings: ok ? st.meetings : null, windowDays: ok ? st.windowDays : null };
    a.notice = 'none';
    save(dir, s);
    return { outcome: 'delivered', done: false, notice: null };
  }
  var n = notice(a, s.delivered);
  a.notice = 'pending';
  save(dir, s);
  return { outcome: c.outcome, done: false, notice: n };
}

/* Only Slack's confirmation makes a notice "posted". Until this is called it is "pending": generated, not delivered. */
function noticeResult(dir, id, result) {
  var s = load(dir), a = s.attempt;
  if (!a || a.id !== id) throw new Error('no attempt ' + id + ' is open');
  if (a.notice !== 'pending') throw new Error('attempt ' + id + ' has no notice waiting on a result');
  if (['posted', 'rejected', 'unknown'].indexOf(result) < 0) throw new Error('--notice-result must be posted (Slack returned a timestamp), rejected (Slack explicitly refused it) or unknown');
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
  if (a.outcome === 'delivered') return delivered && delivered.ref === a.ref ? 'the same one' : when + ' — delivered';
  var note = { pending: 'A notice was generated but not confirmed posted.', posted: 'A notice was posted to your DM.',
               rejected: 'Slack rejected the notice, so it was not posted.', unknown: 'Whether the notice posted is unknown.' }[a.notice] || '';
  var ref = a.ref ? ' (ref ' + a.ref + ')' : '';
  var body = a.outcome === 'started'
    ? 'started; no completion recorded. It may still be running or may have been interrupted; its delivery outcome is unknown.'
    : a.outcome === 'unknown'
      ? 'delivery unknown: Open Loops could not confirm whether the digest posted. Check your DM before running it again.'
      : a.outcome === 'partial'
        ? (a.cause === 'details' ? 'partly delivered' + ref + ': the brief posted, but the full details are unavailable.'
          : (a.details === 'posted' ? 'brief and details posted' : 'the brief posted and the full details are unavailable') +
            ' (brief not verified)' + ref + ': it did not read back as expected, so it may be malformed, and replies to it may not be recognised.')
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
  var dv = s.delivered;
  if (dv) {
    L('Last delivered digest', stamp(dv.at) + ' · ref ' + dv.ref + '\nbrief and details posted; brief verified\n' + readLine(dv));
  } else L('Last delivered digest', 'No verified delivery recorded by status tracking yet');
  L('Last attempt', attemptLine(s.attempt, dv));
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
  load: load, begin: begin, end: end, noticeResult: noticeResult, classify: classify, notice: notice,
  setSchedule: setSchedule, setScheduleState: setScheduleState, gap: gap, gapLine: gapLine, cronDays: cronDays, describeCron: describeCron,
  readFacts: readFacts, stage: stage, view: view, parseNow: parseNow, localDate: localDate,
  file: file, stagedFile: stagedFile
};
