#!/usr/bin/env node
/* Is Open Loops working? What the last attempt did, what was last delivered, and what to post when a
 * run did not deliver.
 *
 *   node tools/status.js --begin [--today YYYY-MM-DD] [--dry] --config <config>      a real run starts: prints ATTEMPT <id>, then
 *        STARTED <epoch seconds> — the `oldest` for any read that has to settle whether a post landed
 *   node tools/status.js --end --attempt <id> --brief posted|rejected|not_attempted|unknown --details posted|rejected|not_attempted|unknown
 *        --verified yes|no [--failed config|ledger|fetch|build|post|verify] [--fetched yes|no] [--ref <ref>] --config <config>
 *        the run is over. Delivered: records it. Otherwise prints the notice to post, once per attempt.
 *        --failed config needs --fetched yes|no: whether Slack had been fetched when the configuration was found unusable
 *        (config and --begin/--end never read the configuration, so they work when it is the thing that is broken)
 *   node tools/status.js --notice-result posted|rejected|not_attempted|unknown --attempt <id> --config <config>
 *        only after Slack answered the notice's own post: posted = a timestamp, rejected = explicitly refused;
 *        not_attempted = no DM to post it in could be found (the failure itself stays recorded)
 *   node tools/status.js --schedule <taskId> "<cron>" --config <config>    the digest task, as the scheduler has it
 *   node tools/status.js --schedule-state paused|resumed|deleted --config <config>   the digest task was paused, resumed or deleted
 *   node tools/status.js --task --config <config>                           the recorded digest task id, or NONE
 *   node tools/status.js --show [--read-only] [--next <ISO> | --paused] --config <config>  the status, for "is it working?"
 *        --read-only never repairs files or refreshes schedule state
 *
 * No network and no Slack. `--dry` is a preview: it records nothing, so it has no failure to report.
 * `--now YYYY-MM-DDTHH:MM` (local time) is for tests.
 */
var fs = require('fs');
var path = require('path');
var S = require('../src/status.js');
var alerts = require('../src/alerts.js');
var diag = require('../src/diagnostics.js');
var { loadConfig } = require('../src/config.js');

var PREVIEW = 'PREVIEW — nothing is recorded, and no failure notice is posted for a preview.';

/* A failure to read or write the record is reported as its own result (exit 5), never as an ordinary success, and says what is and is not known. */
function persistMessage(e) {
  var r = e.reason;
  return e.persist === 'read' ? 'status: could not read status.json (' + r + '). It was not changed.'
    : e.persist === 'uncertain' ? 'status: status.json may or may not have been updated (' + r + '): the new version was written but could not be moved into place. Check with: node tools/status.js --show --read-only'
    : 'status: could not write status.json (' + r + '). It was not changed.';
}
function failure(stdout, stderr) { var e = new Error(stderr); e.stdout = stdout; e.exitCode = 5; return e; }
var NO_RECORD = 'record: NOT RECORDED — this attempt has no record, because --begin could not save one.';
var ONCE = 'This notice is the only one for this attempt: post it once, and do not run --end again. Tell the user the attempt could not be recorded.';

function main(argv, err) {
  try { return mainInner(argv, err); }
  catch (e) {
    if (e.persist && e.exitCode !== 5) throw failure('', persistMessage(e));
    throw e;
  }
}

function mainInner(argv, err) {
  var flag = function (k) { var i = argv.indexOf('--' + k); return i > -1 && argv[i + 1] !== undefined && argv[i + 1].indexOf('--') !== 0 ? argv[i + 1] : null; };
  var has = function (k) { return argv.indexOf('--' + k) > -1; };
  var configPath = flag('config') || 'openloops.config.json';
  var dir = path.dirname(path.resolve(configPath));
  var now = S.parseNow(flag('now') || '');
  err = err || function () {};
  if (has('read-only') && (!has('show') && !has('task') ||
      ['begin', 'end', 'notice-result', 'schedule', 'schedule-state'].some(has))) {
    throw new Error('--read-only is only supported with --show or --task');
  }

  if (has('begin')) {
    if (has('dry')) return PREVIEW + '\nATTEMPT PREVIEW';
    var started = 'STARTED ' + Math.floor(now.getTime() / 1000), began;
    try { began = S.begin(dir, flag('today'), now); }
    catch (e) {
      if (!e.persist) throw e;
      throw failure('ATTEMPT UNRECORDED\n' + started, persistMessage(e) + '\nThe run can continue without an attempt record. End it with: node tools/status.js --end --attempt UNRECORDED --today <date> …: a failure notice is still generated from what the run did.');
    }
    return 'ATTEMPT ' + began + '\n' + started;
  }
  if (has('end') || has('notice-result')) {
    var id = flag('attempt');
    if (!id) throw new Error('--attempt <id> is required: the id --begin printed');
    if (id === 'PREVIEW') return PREVIEW;
    var facts = { brief: flag('brief'), details: flag('details'), verified: flag('verified') === 'yes', failed: flag('failed'), fetched: flag('fetched'), ref: flag('ref') };
    var unrecorded = function (reason, defaultDay) {
      // An attempt that never had a record takes its date from --today alone; one whose record cannot be read now may fall back to the local day.
      var u = S.endUnrecorded(dir, Object.assign({ today: flag('today') || (defaultDay ? S.localDate(now) : null) }, facts));
      throw failure(u.notice ? u.notice.text : 'DELIVERED — NOT RECORDED.', (reason ? reason + '\n' : '') + NO_RECORD + (u.notice ? '\nThis notice is the only one for this attempt: post it once.' : ''));
    };
    if (id === 'UNRECORDED') {
      if (has('notice-result')) throw failure('', NO_RECORD);
      unrecorded('');
    }
    if (has('notice-result')) {
      S.noticeResult(dir, id, flag('notice-result'));
      return 'Recorded.';
    }
    var r;
    try { r = S.end(dir, Object.assign({ id: id }, facts), now); }
    catch (e) {
      if (!e.persist) throw e;
      // The facts are the run's own, so the notice is still made. It is the only one: a retried --end could print it again after it was already posted.
      if (e.result) throw failure(e.result.notice ? e.result.notice.text : 'DELIVERED — NOT RECORDED.', persistMessage(e) + '\n' + (e.result.notice ? ONCE : 'Tell the user the delivery could not be recorded.'));
      unrecorded(persistMessage(e), true);
    }
    if (r.done) return 'ALREADY RECORDED (' + r.outcome + ') — no second notice.';
    if (r.outcome === 'delivered') return 'DELIVERED — recorded.' + (r.superseded ? ' (Attempt ' + id + ' had been replaced by a later one; the last attempt is unchanged.)' : '');
    err('outcome: ' + r.outcome + '\npost: ' + (r.notice.where === 'thread' ? 'the thread under the brief' : 'your own DM') +
        (r.superseded ? '\nattempt ' + id + ' was replaced by a later attempt before it ended; its notice is printed, but it is not the last attempt, so its notice result is not recorded.'
          : '\nwhen Slack has answered that post: node tools/status.js --notice-result posted|rejected|not_attempted|unknown --attempt ' + id));
    return r.notice.text;
  }
  if (has('schedule')) {
    var i = argv.indexOf('--schedule'), taskId = argv[i + 1], cron = argv[i + 2];
    if (!taskId || !cron || taskId.indexOf('--') === 0 || cron.indexOf('--') === 0) throw new Error('--schedule needs <taskId> "<cron>"');
    var sc = S.setSchedule(dir, taskId, cron, now);
    return 'Recorded: ' + sc.taskId + ' at "' + sc.cron + '", counted from ' + sc.since + '.' +
      (S.cronDays(cron) ? '' : ' (That schedule is not a plain time-and-days cron, so no missed day will be reported.)');
  }
  if (has('schedule-state')) {
    var sc2 = S.setScheduleState(dir, flag('schedule-state'), now);
    return 'Recorded: the digest task is ' + sc2.state + '.';
  }
  if (has('task')) {
    var st = S.load(dir);
    return st.schedule && st.schedule.state !== 'deleted' ? st.schedule.taskId : 'NONE';
  }
  if (has('show')) {
    var cfg = loadConfig(fs, configPath);
    if (!has('read-only')) S.repair(dir, now);
    var sched = has('paused') ? { paused: true } : flag('next') ? { next: flag('next') } : null;
    /* What the scheduler says is what the task is: record a pause or a resume the reader made in the app, so the days it
     * was off are not counted as missed. Nothing is recorded when the scheduler could not be read. */
    if (!has('read-only') && sched && S.load(dir).schedule) S.setScheduleState(dir, sched.paused ? 'paused' : 'resumed', now);
    return S.view(dir, cfg, sched, now, { alerts: !!alerts.consent(cfg), diagnostics: !!diag.consent(cfg), readOnly: has('read-only') });
  }
  throw new Error('usage: see the top of tools/status.js');
}

if (require.main === module) {
  try { console.log(main(process.argv.slice(2), function (m) { console.error(m); })); }
  catch (e) {
    if (e.stdout) console.log(e.stdout);
    console.error(e.exitCode === 5 ? e.message : 'status: ' + e.message);
    process.exit(e.exitCode || 1);
  }
}

module.exports = { main: main };
