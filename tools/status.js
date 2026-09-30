#!/usr/bin/env node
/* Is Open Loops working? What the last attempt did, what was last delivered, and what to post when a
 * run did not deliver.
 *
 *   node tools/status.js --begin [--today YYYY-MM-DD] [--dry] --config <config>      a real run starts: prints ATTEMPT <id>, then
 *        STARTED <epoch seconds> — the `oldest` for any read that has to settle whether a post landed
 *   node tools/status.js --end --attempt <id> --brief posted|rejected|not_attempted|unknown --details posted|rejected|not_attempted|unknown
 *        --verified yes|no [--failed fetch|build|post|verify] [--ref <ref>] --config <config>
 *        the run is over. Delivered: records it. Otherwise prints the notice to post, once per attempt.
 *   node tools/status.js --notice-result posted|rejected|unknown --attempt <id> --config <config>
 *        only after Slack answered the notice's own post: posted = a timestamp, rejected = explicitly refused
 *   node tools/status.js --schedule <taskId> "<cron>" --config <config>    the digest task, as the scheduler has it
 *   node tools/status.js --schedule-state paused|resumed|deleted --config <config>   the digest task was paused, resumed or deleted
 *   node tools/status.js --task --config <config>                           the recorded digest task id, or NONE
 *   node tools/status.js --show [--next <ISO> | --paused] --config <config>  the status, for "is it working?"
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

function main(argv, err) {
  var flag = function (k) { var i = argv.indexOf('--' + k); return i > -1 && argv[i + 1] !== undefined && argv[i + 1].indexOf('--') !== 0 ? argv[i + 1] : null; };
  var has = function (k) { return argv.indexOf('--' + k) > -1; };
  var configPath = flag('config') || 'openloops.config.json';
  var dir = path.dirname(path.resolve(configPath));
  var now = S.parseNow(flag('now') || '');
  err = err || function () {};

  if (has('begin')) {
    if (has('dry')) return PREVIEW + '\nATTEMPT PREVIEW';
    return 'ATTEMPT ' + S.begin(dir, flag('today'), now) + '\nSTARTED ' + Math.floor(now.getTime() / 1000);
  }
  if (has('end') || has('notice-result')) {
    var id = flag('attempt');
    if (!id) throw new Error('--attempt <id> is required: the id --begin printed');
    if (id === 'PREVIEW') return PREVIEW;
    if (has('notice-result')) {
      S.noticeResult(dir, id, flag('notice-result'));
      return 'Recorded.';
    }
    var r = S.end(dir, { id: id, brief: flag('brief'), details: flag('details'),
      verified: flag('verified') === 'yes', failed: flag('failed'), ref: flag('ref') }, now);
    if (r.done) return 'ALREADY RECORDED (' + r.outcome + ') — no second notice.';
    if (r.outcome === 'delivered') return 'DELIVERED — recorded.';
    err('outcome: ' + r.outcome + '\npost: ' + (r.notice.where === 'thread' ? 'the thread under the brief' : 'your own DM') +
        '\nwhen Slack has answered that post: node tools/status.js --notice-result posted|rejected|unknown --attempt ' + id);
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
    S.repair(dir, now);   // a damaged record is preserved and its recoverable parts kept, so the status can say so
    var sched = has('paused') ? { paused: true } : flag('next') ? { next: flag('next') } : null;
    /* What the scheduler says is what the task is: record a pause or a resume the reader made in the app, so the days it
     * was off are not counted as missed. Nothing is recorded when the scheduler could not be read. */
    if (sched && S.load(dir).schedule) S.setScheduleState(dir, sched.paused ? 'paused' : 'resumed', now);
    return S.view(dir, cfg, sched, now, { alerts: !!alerts.consent(cfg), diagnostics: !!diag.consent(cfg) });
  }
  throw new Error('usage: see the top of tools/status.js');
}

if (require.main === module) {
  try { console.log(main(process.argv.slice(2), function (m) { console.error(m); })); }
  catch (e) { console.error('status: ' + e.message); process.exit(1); }
}

module.exports = { main: main };
