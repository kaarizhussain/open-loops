/* "Is Open Loops working?": the two records, what counts as delivered, what a failed attempt says, and the gap line.
 *
 * The rules under test: a failure never overwrites the last delivered digest; delivered needs the brief posted,
 * the details posted and the brief read back; an uncertain post is "unknown", never "nothing posted"; a notice
 * says only what is true at its stage and is "posted" only once Slack has said so; one notice per attempt; a
 * preview leaves no record; the previous-digest line appears only after days the schedule expected a digest.
 * Dates are fixed: 2026-10-01 is a Thursday.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var S = require('../src/status.js');
var cli = require('../tools/status.js');
var L = require('../src/ledger.js');
var { main } = require('../slack-run.js');

var tmp = function () { return fs.mkdtempSync(path.join(os.tmpdir(), 'ol-status-')); };
var at = function (s) { return S.parseNow(s); };

/* ------------------------------ the schedule: which days count ------------------------------ */
assert.deepStrictEqual(S.cronDays('0 18 * * *'), [0, 1, 2, 3, 4, 5, 6]);
assert.deepStrictEqual(S.cronDays('0 18 * * 1-5'), [1, 2, 3, 4, 5]);
assert.deepStrictEqual(S.cronDays('0 18 * * 1,3,7'), [0, 1, 3]);
['*/5 * * * *', '0 18 1 * *', '0 18 * 6 *', '0 18 * *', '0 18 * * MON', '0 18 * * 5-1', ''].forEach(function (c) {
  assert.strictEqual(S.cronDays(c), null, 'not a plain time-and-days cron: ' + c);
});
assert.strictEqual(S.describeCron('0 18 * * *'), 'every day');
assert.strictEqual(S.describeCron('0 18 * * 1-5'), 'weekdays');

var dir = tmp();
var cfgPath = path.join(dir, 'openloops.config.json');
fs.writeFileSync(cfgPath, JSON.stringify({ you: 'alex@example.com', channels: { include: ['#ops', '#vendors', 'DM with Lena H'], exclude: ['#social'] } }));
var delivered = function (d, ref) {
  var id = S.begin(dir, d, at(d + 'T18:03'));
  return S.end(dir, { id: id, brief: 'posted', details: 'posted', verified: true, ref: ref }, at(d + 'T18:04'));
};

/* ------------------------------ the gap line: only after days the schedule expected ------------------------------ */
assert.strictEqual(S.gap(dir, '2026-10-05'), null, 'no delivered digest, no gap');
delivered('2026-09-28', 'aaaa');
S.setSchedule(dir, 'task-1', '0 18 * * *', at('2026-09-29T09:00'));
var g = S.gap(dir, '2026-10-01');
assert.deepStrictEqual(g, { prev: '2026-09-28', missed: ['2026-09-30'] }, 'a daily schedule since the 29th expected the 29th and 30th');
// ^ the 29th is the day it began: it counts from the day AFTER, so only the 30th is expected-and-missing
assert.strictEqual(S.gapLine(g), 'Previous digest: Mon 09-28 · none on Wed 09-30.');
assert.strictEqual(S.gap(dir, '2026-09-29'), null, 'the digest is today: nothing between');
assert.strictEqual(S.gap(dir, '2026-09-30'), null, 'yesterday was not expected: the schedule began then');
S.setSchedule(dir, 'task-1', '0 18 * * *', at('2026-10-20T09:00'));
assert.strictEqual(S.load(dir).schedule.since, '2026-09-29', 'refreshing the same schedule does not move where it began');
S.setSchedule(dir, 'task-1', '0 18 * * 1-5', at('2026-10-20T09:00'));
assert.strictEqual(S.load(dir).schedule.since, '2026-10-20', 'a changed schedule counts from the day it changed');
// Weekdays: the weekend is not a missed run.
var d2 = tmp(); var c2 = path.join(d2, 'c.json'); fs.writeFileSync(c2, '{}');
(function () {
  var id = S.begin(d2, '2026-10-02', at('2026-10-02T18:03'));
  S.end(d2, { id: id, brief: 'posted', details: 'posted', verified: true, ref: 'bbbb' }, at('2026-10-02T18:04'));   // Friday
  S.setSchedule(d2, 't', '0 18 * * 1-5', at('2026-09-01T09:00'));
  assert.strictEqual(S.gap(d2, '2026-10-05'), null, 'Friday to Monday on a weekday schedule is not a gap');
  assert.deepStrictEqual(S.gap(d2, '2026-10-06').missed, ['2026-10-05'], 'but a missed Monday is');
  S.setSchedule(d2, 't', '*/5 * * * *', at('2026-09-01T09:00'));
  assert.strictEqual(S.gap(d2, '2026-10-20'), null, 'a schedule this cannot read expects nothing, so nothing is missed');
})();
var d3 = tmp(); // delivered, never a schedule recorded (an existing install): no gap line
(function () { var id = S.begin(d3, '2026-09-01'); S.end(d3, { id: id, brief: 'posted', details: 'posted', verified: true }); assert.strictEqual(S.gap(d3, '2026-10-20'), null); })();

/* ------------------------------ paused days are not missed days ------------------------------ */
var dp = tmp();
(function () {
  var id = S.begin(dp, '2026-09-10', at('2026-09-10T18:03'));
  S.end(dp, { id: id, brief: 'posted', details: 'posted', verified: true, ref: 'cccc' }, at('2026-09-10T18:04'));
  assert.throws(function () { S.setScheduleState(dp, 'paused', at('2026-09-12T10:00')); }, /no digest task is recorded/, 'nothing to pause before a task is recorded');
  S.setSchedule(dp, 't', '0 18 * * *', at('2026-09-01T09:00'));
  assert.deepStrictEqual(S.gap(dp, '2026-09-17').missed, ['2026-09-11', '2026-09-12', '2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16'], 'control: with no pause every expected day is missed');
  S.setScheduleState(dp, 'paused', at('2026-09-12T10:00'));
  S.setScheduleState(dp, 'paused', at('2026-09-13T10:00'));
  assert.strictEqual(S.load(dp).schedule.off.length, 1, 'pausing a paused task adds nothing');
  assert.deepStrictEqual(S.gap(dp, '2026-09-20').missed, ['2026-09-11'], 'days while it is paused are not missed, even before it is resumed');
  S.setSchedule(dp, 't', '0 18 * * *', at('2026-09-14T09:00'));
  assert.strictEqual(S.load(dp).schedule.state, 'paused', 'refreshing the schedule does not resume it');
  assert.deepStrictEqual(S.gap(dp, '2026-09-20').missed, ['2026-09-11']);
  S.setScheduleState(dp, 'resumed', at('2026-09-15T10:00'));
  assert.deepStrictEqual(S.gap(dp, '2026-09-17').missed, ['2026-09-11', '2026-09-16'], 'the paused days stay excluded after the resume; a later missed day counts');
  S.setScheduleState(dp, 'resumed', at('2026-09-16T10:00'));
  assert.strictEqual(S.load(dp).schedule.off[0].to, '2026-09-15', 'resuming a running task changes nothing');
  S.setScheduleState(dp, 'paused', at('2026-09-16T08:00'));
  assert.strictEqual(S.load(dp).schedule.off.length, 2, 'a second pause is its own stretch');
  assert.deepStrictEqual(S.gap(dp, '2026-09-20').missed, ['2026-09-11'], 'and is excluded from the 16th on');
  S.setScheduleState(dp, 'deleted', at('2026-09-18T10:00'));
  assert.strictEqual(S.gap(dp, '2026-09-20'), null, 'a deleted task expects nothing');
  assert.strictEqual(S.setScheduleState(dp, 'paused', at('2026-09-19T10:00')).state, 'deleted', 'and cannot be paused back to life');
  assert.throws(function () { S.setScheduleState(dp, 'sleeping', at('2026-09-19T10:00')); }, /must be paused, resumed or deleted/);
  S.setSchedule(dp, 't2', '0 18 * * *', at('2026-09-19T09:00'));
  var re = S.load(dp).schedule;
  assert.ok(re.state === 'active' && re.off.length === 0 && re.since === '2026-09-19', 'a new task starts clean, counted from the day it was made');
  assert.strictEqual(S.gap(dp, '2026-09-22').missed.join(), '2026-09-20,2026-09-21');
})();

/* ------------------------------ what the facts add up to ------------------------------ */
var C = function (brief, details, verified, failed) { return S.classify({ brief: brief, details: details, verified: verified, failed: failed || '' }); };
assert.deepStrictEqual(C('posted', 'posted', true), { outcome: 'delivered' });
assert.deepStrictEqual(C('posted', 'posted', false), { outcome: 'partial', cause: 'verify' }, 'both posted, brief did not read back: not delivered');
assert.deepStrictEqual(C('posted', 'rejected', true), { outcome: 'partial', cause: 'details' }, 'the brief alone is partial');
assert.deepStrictEqual(C('posted', 'not_attempted', false), { outcome: 'partial', cause: 'details' });
assert.deepStrictEqual(C('not_attempted', 'not_attempted', false, 'fetch'), { outcome: 'not_delivered', cause: 'fetch' });
assert.deepStrictEqual(C('not_attempted', 'not_attempted', false, 'build'), { outcome: 'not_delivered', cause: 'build' });
assert.deepStrictEqual(C('rejected', 'not_attempted', false, 'post'), { outcome: 'not_delivered', cause: 'post' });
assert.deepStrictEqual(C('rejected', 'not_attempted', false), { outcome: 'not_delivered', cause: 'post' });
assert.deepStrictEqual(C('unknown', 'not_attempted', false), { outcome: 'unknown' }, 'an uncertain post is unknown, not "nothing posted"');
assert.deepStrictEqual(C('posted', 'unknown', true), { outcome: 'unknown' }, 'an uncertain details post is unknown, not partial');
assert.deepStrictEqual(C('rejected', 'posted', true), { outcome: 'unknown' }, 'facts that contradict each other are not guessed at');
assert.deepStrictEqual(C('posted', 'posted', true, 'post'), { outcome: 'delivered' }, 'a stage named on a delivered run is ignored');

/* ------------------------------ absence proves nothing ------------------------------ */
// Not finding a post — even on a complete read of the DM — is not evidence it did not post: it may carry a damaged header,
// or still be in flight after a timeout. So there is no way to report "not there"; only Slack refusing it, or never trying.
var dU = tmp(), uid = S.begin(dU, '2026-09-30', at('2026-09-30T18:03'));
['not_posted', 'na', 'absent', 'not_found'].forEach(function (v) {
  assert.throws(function () { S.end(dU, { id: uid, brief: v, details: 'not_attempted', verified: false, failed: 'post' }); }, /absence proves nothing/, v + ' cannot be reported for the brief');
  assert.throws(function () { S.end(dU, { id: uid, brief: 'posted', details: v, verified: true }); }, /absence proves nothing/, v + ' cannot be reported for the details');
});
assert.throws(function () { S.end(dU, { id: uid, brief: 'not_attempted', details: 'not_attempted', verified: false, failed: 'post' }); }, /only fits a run that stopped before posting/, 'a tried post is not "never attempted"');
assert.throws(function () { S.end(dU, { id: uid, brief: 'not_attempted', details: 'not_attempted', verified: false }); }, /only fits a run that stopped before posting/);
assert.strictEqual(S.load(dU).attempt.outcome, 'started', 'a fact that cannot be reported records nothing');
// What can be reported for a post that may or may not have landed is unknown, with no claim that nothing was posted and no retry on its own.
var ux = S.end(dU, { id: uid, brief: 'unknown', details: 'not_attempted', verified: false, failed: 'post' }, at('2026-09-30T18:05'));
assert.strictEqual(ux.outcome, 'unknown');
assert.ok(/Check this DM before running it again: it may already be here\./.test(ux.notice.text) && !/Nothing was posted|did not post|was not posted/.test(ux.notice.text), ux.notice.text);
assert.ok(/delivery unknown/.test(S.view(dU, {}, null, at('2026-09-30T19:00'))) && !/Nothing was posted/.test(S.view(dU, {}, null, at('2026-09-30T19:00'))));
assert.strictEqual(S.classify({ brief: 'unknown', details: 'posted', verified: true, failed: '' }).outcome, 'unknown', 'a details message found in the thread does not make an unknown brief delivered');
// The instructions say the same: a complete read with no match is still unknown.
var skillText = fs.readFileSync(path.join(__dirname, '..', 'skills', 'open-loops', 'SKILL.md'), 'utf8').split(String.fromCharCode(13)).join('');
assert.ok(/even on a read that\s+covered the whole period — proves nothing/.test(skillText) && /damaged header/.test(skillText) && /in flight/.test(skillText), 'SKILL.md: not finding the post proves nothing');
assert.ok(!/it is not there, it did not/.test(skillText) && !/`not_posted`/.test(skillText), 'SKILL.md no longer lets absence count as "not posted"');

/* ------------------------------ a failure never overwrites the last delivery ------------------------------ */
var dir2 = tmp();
var stagedOf = function (dd, ref, state) {
  S.stage(dd, { ref: ref, date: '2026-09-29', read: { state: state || 'complete', why: [] }, channels: ['#ops', '#vendors'],
    conversations: 2, messages: 40, meetings: 3, windowDays: 21 });
};
stagedOf(dir2, '6261');
var a1 = S.begin(dir2, '2026-09-29', at('2026-09-29T18:03'));
var r1 = S.end(dir2, { id: a1, brief: 'posted', details: 'posted', verified: true, ref: '6261' }, at('2026-09-29T18:05'));
assert.strictEqual(r1.outcome, 'delivered'); assert.strictEqual(r1.notice, null, 'a delivered run has no notice');
var st1 = S.load(dir2);
assert.strictEqual(st1.delivered.ref, '6261'); assert.strictEqual(st1.delivered.date, '2026-09-29');
assert.strictEqual(st1.delivered.read.state, 'complete'); assert.deepStrictEqual(st1.delivered.channels, ['#ops', '#vendors']);
var deliveredBefore = JSON.stringify(st1.delivered);

var a2 = S.begin(dir2, '2026-09-30', at('2026-09-30T18:03'));
var stA = S.load(dir2);
assert.strictEqual(stA.attempt.outcome, 'started'); assert.strictEqual(JSON.stringify(stA.delivered), deliveredBefore, 'beginning an attempt leaves the delivery alone');
var r2 = S.end(dir2, { id: a2, brief: 'not_attempted', details: 'not_attempted', verified: false, failed: 'fetch' }, at('2026-09-30T18:04'));
assert.strictEqual(r2.outcome, 'not_delivered');
assert.strictEqual(JSON.stringify(S.load(dir2).delivered), deliveredBefore, 'a failed attempt does not touch the last delivered digest');
assert.ok(/Last delivered digest: Tue 2026-09-29 · ref 6261/.test(r2.notice.text), 'and the notice keeps it findable: ' + r2.notice.text);
// One notice per attempt.
var r2b = S.end(dir2, { id: a2, brief: 'not_attempted', details: 'not_attempted', verified: false, failed: 'fetch' }, at('2026-09-30T18:05'));
assert.strictEqual(r2b.notice, null, 'a second end for the same attempt issues no second notice'); assert.ok(r2b.done);
// A second failed attempt is its own attempt, with its own notice.
var a3 = S.begin(dir2, '2026-09-30', at('2026-09-30T19:03'));
assert.ok(S.end(dir2, { id: a3, brief: 'not_attempted', details: 'not_attempted', verified: false, failed: 'build' }, at('2026-09-30T19:04')).notice);
// A run that never ends stays "started": no guess at its outcome.
var a4 = S.begin(dir2, '2026-10-01', at('2026-10-01T18:03'));
assert.strictEqual(S.load(dir2).attempt.outcome, 'started');
assert.throws(function () { S.end(dir2, { id: a2, brief: 'posted', details: 'posted', verified: true }); }, /no attempt/, 'an old id cannot end the current attempt');
assert.throws(function () { S.end(dir2, { id: a4, brief: 'maybe', details: 'posted', verified: true }); }, /--brief/);

/* ------------------------------ a notice is "posted" only when Slack said so ------------------------------ */
var dir3 = tmp();
var b1 = S.begin(dir3, '2026-09-30', at('2026-09-30T18:03'));
S.end(dir3, { id: b1, brief: 'rejected', details: 'not_attempted', verified: false, failed: 'post' }, at('2026-09-30T18:04'));
assert.strictEqual(S.load(dir3).attempt.notice, 'pending', 'generating the text is not delivering it');
assert.ok(/A notice was generated but not confirmed posted\./.test(S.view(dir3, {}, null, at('2026-09-30T19:00'))), 'and the status says so');
S.noticeResult(dir3, b1, 'posted');
assert.ok(/A notice was posted to your DM\./.test(S.view(dir3, {}, null, at('2026-09-30T19:00'))));
assert.throws(function () { S.noticeResult(dir3, b1, 'posted'); }, /no notice waiting/, 'a result is recorded once');
var b2 = S.begin(dir3, '2026-10-01', at('2026-10-01T18:03'));
assert.throws(function () { S.noticeResult(dir3, b2, 'posted'); }, /no notice waiting/, 'a notice that was never generated cannot be confirmed');
S.end(dir3, { id: b2, brief: 'rejected', details: 'not_attempted', verified: false, failed: 'post' }, at('2026-10-01T18:04'));
assert.throws(function () { S.noticeResult(dir3, b2, 'not_posted'); }, /must be posted/, 'a notice that "was not there" is not a result');
S.noticeResult(dir3, b2, 'unknown');
assert.ok(/Whether the notice posted is unknown\./.test(S.view(dir3, {}, null, at('2026-10-01T19:00'))));
assert.throws(function () { S.noticeResult(dir3, b2, 'yes'); }, /no notice waiting|must be/);

/* ------------------------------ each notice says only what is true at its stage ------------------------------ */
var N = function (outcome, cause, details) { return S.notice({ outcome: outcome, cause: cause, details: details, date: '2026-09-30' }, { date: '2026-09-29', ref: '6261' }); };
var nf = N('not_delivered', 'fetch');
assert.ok(nf.text.indexOf('OPEN LOOPS NOT RUN — for 2026-09-30\n') === 0 && nf.where === 'dm');
assert.ok(/could not fetch Slack[^.]*nothing was checked and nothing was posted/.test(nf.text), 'fetch failed: nothing was checked is true here');
var nb = N('not_delivered', 'build');
assert.ok(/Slack was fetched, but processing failed/.test(nb.text), nb.text);
assert.ok(!/nothing was checked/i.test(nb.text), 'a build failure does not claim nothing was checked');
var np = N('not_delivered', 'post');
assert.ok(/was built, but it could not be posted\. Nothing was posted\./.test(np.text), np.text);
assert.ok(!/nothing was checked/i.test(np.text), 'a post failure does not claim nothing was checked either');
[nf, nb, np].forEach(function (n) { assert.ok(/An empty DM today does not mean nothing is outstanding/.test(n.text) && /run Open Loops/.test(n.text)); });
var nd = N('partial', 'details', 'rejected');
assert.ok(nd.text.indexOf('OPEN LOOPS NOTES — for 2026-09-30\n') === 0 && nd.where === 'thread');
assert.ok(/The brief posted, but the full details are unavailable/.test(nd.text), nd.text);
assert.ok(!/complete/i.test(nd.text), 'the brief is not called complete when its details are missing');
var nv1 = N('partial', 'verify', 'posted'), nv2 = N('partial', 'verify', 'rejected');
assert.ok(/The brief and details posted, but the brief did not read back as expected/.test(nv1.text), nv1.text);
assert.ok(/full details are unavailable, and the brief did not read back/.test(nv2.text), nv2.text);
assert.ok(!/verified/.test(nv1.text), 'the details were never read back, so nothing says they were verified');
var nu = N('unknown');
assert.ok(nu.text.indexOf('OPEN LOOPS DELIVERY UNKNOWN — for 2026-09-30\n') === 0 && nu.where === 'dm');
assert.ok(/could not confirm whether today's digest posted\. Check this DM before running it again/.test(nu.text), nu.text);
assert.ok(!/Nothing was posted/.test(nu.text), 'unknown is not "nothing was posted"');
assert.ok(/No verified delivery recorded by status tracking yet\./.test(S.notice({ outcome: 'unknown', date: '2026-09-30' }, null).text), 'with no delivery on record it says only that');
assert.ok(!/has been delivered|none yet/i.test(S.notice({ outcome: 'unknown', date: '2026-09-30' }, null).text), 'and never claims nothing was delivered: an existing user has had digests');
// None of it carries message text: only dates, a ref and fixed sentences.
[nf, nb, np, nd, nv1, nv2, nu].forEach(function (n) { assert.ok(n.text.length < 600); });

/* ------------------------------ the status, in every state ------------------------------ */
var scope = { alerts: false, diagnostics: false };
var cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
var dir4 = tmp();
var v0 = S.view(dir4, cfg, null, at('2026-09-30T16:42'), scope);
assert.ok(/Last delivered digest {3}No verified delivery recorded by status tracking yet\n/.test(v0) && /Last attempt {12}none recorded/.test(v0), v0);
assert.ok(!/none yet/.test(v0), 'missing records do not prove nothing was delivered');
assert.ok(/Next run {16}unknown — the scheduler could not be read/.test(v0), 'no scheduler information: unknown, no time inferred');
stagedOf(dir4, '6261');
var id4 = S.begin(dir4, '2026-09-29', at('2026-09-29T18:03'));
S.end(dir4, { id: id4, brief: 'posted', details: 'posted', verified: true, ref: '6261' }, at('2026-09-29T18:05'));
S.setSchedule(dir4, 'task-1', '0 18 * * *', at('2026-09-01T09:00'));
var v1 = S.view(dir4, cfg, { next: new Date(2026, 8, 30, 18, 2).toISOString() }, at('2026-09-30T16:42'), scope);
assert.ok(/brief and details posted; brief verified/.test(v1) && !/details (were )?verified/.test(v1), v1);
assert.ok(/Tue 09-29, 18:05 · ref 6261/.test(v1) && /read in full: 2 conversations, 3 meetings, 21 days back/.test(v1), v1);
assert.ok(/Last attempt {12}the same one/.test(v1), v1);
assert.ok(/Next run {16}today, about 18:02 \(every day, your local time\)/.test(v1), v1);
assert.ok(/Tracking {16}#ops {2}#vendors\n/.test(v1) && /Not tracking {12}#social \(excluded\)/.test(v1), v1);
assert.ok(/Direct messages {9}your own DM \(the digest and your replies\); also DM with Lena H \(named in your config\)/.test(v1), 'DM scope is what the config names: ' + v1);
assert.ok(!/never read/.test(v1), 'it never claims direct messages are never read');
var vNo = S.view(dir4, { channels: { include: ['#ops'] } }, null, at('2026-09-30T16:42'), scope);
assert.ok(/Direct messages {9}your own DM \(the digest and your replies\); no others are named in your config, so none are read/.test(vNo), vNo);
var vEmpty = S.view(dir4, {}, null, at('2026-09-30T16:42'), scope);
assert.ok(/every channel it is handed \(no include list is set\)/.test(vEmpty), vEmpty);
assert.ok(/Next run {16}paused — nothing will run until you resume it\./.test(S.view(dir4, cfg, { paused: true }, at('2026-09-30T16:42'), scope)));
assert.ok(/Next run {16}tomorrow, about 18:02/.test(S.view(dir4, cfg, { next: new Date(2026, 9, 1, 18, 2).toISOString() }, at('2026-09-30T16:42'), scope)));
assert.ok(/Midday alerts off · Diagnostic reports off/.test(v1) && /Midday alerts on · Diagnostic reports on/.test(S.view(dir4, cfg, null, at('2026-09-30T16:42'), { alerts: true, diagnostics: true })));
assert.ok(/No digest since Tue 09-29; the schedule expected one on Wed 09-30\./.test(S.view(dir4, cfg, null, at('2026-10-01T16:42'), scope)), 'a gap is said in the status too');

// Last attempt, every state: the delivered block is untouched by all of them.
var att = function (facts, now) {
  var x = S.begin(dir4, '2026-10-01', at('2026-10-01T18:03'));
  if (facts) S.end(dir4, Object.assign({ id: x }, facts), at('2026-10-01T18:04'));
  return S.view(dir4, cfg, null, at(now || '2026-10-01T19:00'), scope);
};
var vs = att(null);
assert.ok(/Last attempt {12}Thu 10-01, 18:03 — started; no completion recorded\. It may still be running or may have been interrupted; its delivery outcome is unknown\./.test(vs), vs);
assert.ok(!/failed/i.test(vs), 'a started attempt is not called failed');
var vf = att({ brief: 'not_attempted', details: 'not_attempted', verified: false, failed: 'build' });
assert.ok(/Slack was fetched, but processing failed\. Nothing was posted\./.test(vf) && !/nothing was checked/i.test(vf), vf);
assert.ok(/Tue 09-29, 18:05 · ref 6261/.test(vf), 'the last delivered digest is still shown: ' + vf);
assert.ok(/Slack could not be fetched\. Nothing was posted\./.test(att({ brief: 'not_attempted', details: 'not_attempted', verified: false, failed: 'fetch' })));
assert.ok(/the digest was built, but posting failed\. Nothing was posted\./.test(att({ brief: 'rejected', details: 'not_attempted', verified: false, failed: 'post' })));
assert.ok(/partly delivered \(ref 7c1e\): the brief posted, but the full details are unavailable\./.test(att({ brief: 'posted', details: 'rejected', verified: true, ref: '7c1e' })));
var vv = att({ brief: 'posted', details: 'posted', verified: false, ref: '7c1e' });
assert.ok(/brief and details posted \(brief not verified\)/.test(vv) && /replies to it may not be recognised/.test(vv), vv);
assert.ok(/delivery unknown: Open Loops could not confirm whether the digest posted\. Check your DM before running it again\./.test(att({ brief: 'unknown', details: 'not_attempted', verified: false })));
assert.ok(!/Nothing was posted/.test(att({ brief: 'unknown', details: 'not_attempted', verified: false })), 'unknown is never reported as nothing posted');

// A delivered digest whose read was incomplete says where.
stagedOf(dir4, '7c1e', 'incomplete');
var st7 = JSON.parse(fs.readFileSync(S.stagedFile(dir4), 'utf8')); st7.read.why = ['#vendors: more pages remain']; fs.writeFileSync(S.stagedFile(dir4), JSON.stringify(st7));
var vi = att({ brief: 'posted', details: 'posted', verified: true, ref: '7c1e' });
assert.ok(/the read was incomplete: #vendors: more pages remain\. Details are in the digest's thread\./.test(vi), vi);
// Delivered without matching staged facts: it says the read was not recorded rather than "in full".
var id5 = S.begin(dir4, '2026-10-02'); S.end(dir4, { id: id5, brief: 'posted', details: 'posted', verified: true, ref: 'ffff' });
assert.ok(/how completely it read was not recorded/.test(S.view(dir4, cfg, null, at('2026-10-02T19:00'), scope)));

/* ------------------------------ the CLI ------------------------------ */
var dir5 = tmp(), cp5 = path.join(dir5, 'openloops.config.json'); fs.writeFileSync(cp5, JSON.stringify({ you: 'a@b.co', channels: { include: ['#ops'] } }));
var errs = [];
var run = function (args) { return cli.main(args.concat(['--config', cp5]), function (m) { errs.push(m); }); };
assert.ok(/^PREVIEW/.test(run(['--begin', '--dry'])) && !fs.existsSync(S.file(dir5)), 'a preview records nothing');
assert.ok(/^PREVIEW/.test(run(['--end', '--attempt', 'PREVIEW', '--brief', 'not_attempted', '--details', 'not_attempted', '--verified', 'no', '--failed', 'fetch'])) && !fs.existsSync(S.file(dir5)),
  'and a preview that "fails" issues no notice and records nothing');
var begun = run(['--begin', '--today', '2026-10-01', '--now', '2026-10-01T18:03']); var aid = begun.split('\n')[0].replace('ATTEMPT ', '');
assert.ok(/^ATTEMPT [0-9a-f]{8}\nSTARTED \d{10}$/.test(begun), 'begin also prints the start, as the oldest for any read that settles a post: ' + begun);
assert.strictEqual(+begun.split('\n')[1].replace('STARTED ', ''), Math.floor(new Date(2026, 9, 1, 18, 3).getTime() / 1000));
var out = run(['--end', '--attempt', aid, '--brief', 'posted', '--details', 'rejected', '--verified', 'yes']);
assert.ok(out.indexOf('OPEN LOOPS NOTES — for 2026-10-01\n') === 0, out);
assert.ok(/outcome: partial/.test(errs.join('\n')) && /the thread under the brief/.test(errs.join('\n')), 'where to post it goes to stderr, not into the message');
assert.ok(/^ALREADY RECORDED/.test(run(['--end', '--attempt', aid, '--brief', 'posted', '--details', 'rejected', '--verified', 'yes'])));
assert.strictEqual(run(['--notice-result', 'posted', '--attempt', aid]), 'Recorded.');
assert.strictEqual(run(['--task']), 'NONE');
assert.ok(/^Recorded: t1 at "0 18 \* \* 1-5"/.test(run(['--schedule', 't1', '0 18 * * 1-5'])) && run(['--task']) === 't1');
assert.ok(/not a plain time-and-days cron/.test(run(['--schedule', 't1', '*/5 * * * *'])));
assert.ok(/^OPEN LOOPS — status/.test(run(['--show'])) && /Next run {16}unknown/.test(run(['--show'])));
assert.strictEqual(S.load(dir5).schedule.state, 'active', 'a status that could not read the scheduler records nothing about it');
run(['--show', '--paused', '--now', '2026-10-02T10:00']);
assert.strictEqual(S.load(dir5).schedule.state, 'paused', 'a scheduler that says paused is recorded as a pause');
run(['--show', '--next', new Date(2026, 9, 6, 18, 2).toISOString(), '--now', '2026-10-05T10:00']);
var sc5 = S.load(dir5).schedule;
assert.ok(sc5.state === 'active' && sc5.off.length === 1 && sc5.off[0].from === '2026-10-02' && sc5.off[0].to === '2026-10-05', 'and a resume in the app is recorded too: ' + JSON.stringify(sc5));
assert.ok(/^Recorded: the digest task is paused\./.test(run(['--schedule-state', 'paused'])));
assert.ok(/^Recorded: the digest task is deleted\./.test(run(['--schedule-state', 'deleted'])) && run(['--task']) === 'NONE', 'a deleted task is no task');
assert.ok(/Next run {16}none — the digest task was deleted on /.test(run(['--show'])));
assert.throws(function () { run(['--end', '--brief', 'posted']); }, /--attempt/);
var aid2 = run(['--begin', '--today', '2026-10-02']).split('\n')[0].replace('ATTEMPT ', '');
assert.throws(function () { run(['--end', '--attempt', aid2, '--brief', 'not_posted', '--details', 'not_attempted', '--verified', 'no', '--failed', 'post']); }, /absence proves nothing/, 'the command line cannot report absence either');

/* ------------------------------ the runner: staging, the gap line, previews, and the DM reader ------------------------------ */
var ME = 'alex@example.com';
var stamp = function (ts) { return '=== Message from Lena Borg <lena@vectorfreight.example> (U0EXAMPLE002) at ' + ts + ' UTC ===\nMessage TS: ' + ts + '\n'; };
var rdir = tmp(), rcfg = path.join(rdir, 'openloops.config.json');
fs.writeFileSync(rcfg, JSON.stringify({ you: ME, selfDm: 'U0EXAMPLE001', tzOffset: 0, spotCheck: 0, ledger: path.join(rdir, 'ledger.json'),
  channels: { include: ['#vector-freight'] } }));
var chat = function (extra) {
  return stamp((Date.UTC(2026, 8, 28, 14) / 1000).toFixed(6)) + "We'll get the revised contract back to you Thursday Oct 1." + (extra || '');
};
var inp = function (today, conv) {
  var p = path.join(rdir, 'in-' + today + '.json');
  fs.writeFileSync(p, JSON.stringify({ today: today, conversations: [conv || { channel: '#vector-freight', members: [], text: chat(), complete: true }], dm: { channel: 'D0', text: '' } }));
  return p;
};
var refOf = function (t) { return (t.split('\n')[0].match(/· ref ([0-9a-f]{4})/) || [])[1]; };

main([inp('2026-09-30'), '--config', rcfg, '--dry']);
assert.ok(!fs.existsSync(S.stagedFile(rdir)), 'a preview stages nothing');
var dg = main([inp('2026-09-30'), '--config', rcfg]);
var staged = JSON.parse(fs.readFileSync(S.stagedFile(rdir), 'utf8'));
assert.strictEqual(staged.ref, refOf(dg)); assert.strictEqual(staged.read.state, 'complete', JSON.stringify(staged.read));
assert.deepStrictEqual(staged.channels, ['#vector-freight']); assert.strictEqual(staged.windowDays, 21);
assert.ok(!fs.existsSync(S.file(rdir)), 'the runner only stages: status.json has one writer');
assert.ok(!/Previous digest:/.test(dg), 'no line without a delivery and a schedule');
var rid = S.begin(rdir, '2026-09-30', at('2026-09-30T18:03'));
S.end(rdir, { id: rid, brief: 'posted', details: 'posted', verified: true, ref: refOf(dg) }, at('2026-09-30T18:04'));
assert.strictEqual(S.load(rdir).delivered.read.state, 'complete');
assert.ok(!/Previous digest:/.test(main([inp('2026-10-01'), '--config', rcfg])), 'the day after a delivery is not a gap');
S.setSchedule(rdir, 'task-1', '0 18 * * *', at('2026-09-29T09:00'));
var dgap = main([inp('2026-10-03'), '--config', rcfg]);
assert.ok(/\nPrevious digest: Wed 09-30 · none on Thu 10-01, Fri 10-02\.\n/.test(dgap), dgap);
S.setSchedule(rdir, 'task-1', '0 18 * * 1-5', at('2026-09-29T09:00'));
assert.ok(/\nPrevious digest: Wed 09-30 · none on Thu 10-01, Fri 10-02\.\n/.test(main([inp('2026-10-03'), '--config', rcfg, '--dry'])),
  'a weekday schedule still expected the Thursday and Friday');
S.setSchedule(rdir, 'task-1', '0 18 * * 1', at('2026-09-29T09:00'));
assert.ok(!/Previous digest:/.test(main([inp('2026-10-03'), '--config', rcfg, '--dry'])), 'a Monday-only schedule expected neither, so nothing was missed');

S.setSchedule(rdir, 'task-1', '0 18 * * *', at('2026-09-29T09:00'));
assert.ok(/Previous digest:/.test(main([inp('2026-10-03'), '--config', rcfg, '--dry'])), 'control: a daily schedule raises the line');
S.setScheduleState(rdir, 'paused', at('2026-09-30T20:00'));
assert.ok(!/Previous digest:/.test(main([inp('2026-10-03'), '--config', rcfg, '--dry'])), 'a task paused since the 30th was not missed on the 1st and 2nd');
S.setScheduleState(rdir, 'resumed', at('2026-10-03T08:00'));
assert.ok(!/Previous digest:/.test(main([inp('2026-10-03'), '--config', rcfg, '--dry'])), 'and resuming does not bring them back');
S.setScheduleState(rdir, 'deleted', at('2026-10-03T09:00'));
assert.ok(!/Previous digest:/.test(main([inp('2026-10-03'), '--config', rcfg, '--dry'])), 'a deleted task expects nothing');
// An incomplete read is staged as incomplete; one that parsed nothing is staged as nothing.
var partial = main([inp('2026-10-05', { channel: '#vector-freight', members: [], text: chat() }), '--config', rcfg]);
assert.strictEqual(JSON.parse(fs.readFileSync(S.stagedFile(rdir), 'utf8')).read.state, 'incomplete');
assert.ok(/INCOMPLETE|read warning/.test(partial));
var blind = main([inp('2026-10-06', { channel: '#vector-freight', members: [], text: 'nothing here looks like a message at all' }), '--config', rcfg]);
assert.ok(/READ NOTHING/.test(blind), blind);
assert.strictEqual(JSON.parse(fs.readFileSync(S.stagedFile(rdir), 'utf8')).read.state, 'nothing', 'the status record agrees with the digest');

// The DM reader skips every notice. A reply of "1" under a digest rejects item 1, so a notice that carried such a line
// would reject a real item unless the reader skips it by its header. Each header is tried after a real digest.
var dmMsg = function (ts, body) { return '=== Message from Alex Rivera <' + ME + '> (U0EXAMPLE001) at ' + ts + ' UTC ===\nMessage TS: ' + ts + '\n' + body; };
var withDm = function (header, extra) {
  var d = tmp(), c = path.join(d, 'c.json'), ledger = path.join(d, 'ledger.json'), p = path.join(d, 'i.json');
  fs.writeFileSync(c, JSON.stringify({ you: ME, selfDm: 'U0EXAMPLE001', tzOffset: 0, spotCheck: 0, ledger: ledger, channels: { include: ['#vector-freight'] } }));
  var conv = { channel: '#vector-freight', members: [], text: chat(), complete: true };
  fs.writeFileSync(p, JSON.stringify({ today: '2026-09-30', conversations: [conv], dm: { channel: 'D0', text: '' } }));
  var d1 = main([p, '--config', c]);
  var t1 = (Date.UTC(2026, 8, 30, 22) / 1000).toFixed(6), t2 = (Date.UTC(2026, 9, 1, 13) / 1000).toFixed(6);
  fs.writeFileSync(p, JSON.stringify({ today: '2026-10-01', conversations: [conv],
    dm: { channel: 'D0', text: dmMsg(t1, '```\n' + d1 + '\n```') + '\n' + dmMsg(t2, header + '\n' + extra) } }));
  var out = main([p, '--config', c]);
  var rows = JSON.parse(fs.readFileSync(ledger, 'utf8')).rows;
  return { ok: rows.length > 0 && rows.every(function (r) { return !r[L.COL.verdict]; }) && !/Took your last reply|NOT APPLIED|NOT READ AS A CORRECTION/.test(out), out: out };
};
assert.ok(!withDm('just a note from me', '1').ok, 'control: a bare "1" under a digest does reject item 1');
['OPEN LOOPS NOT RUN — for 2026-10-01', 'OPEN LOOPS DELIVERY UNKNOWN — for 2026-10-01', 'OPEN LOOPS NOTES — for 2026-10-01'].forEach(function (h) {
  assert.ok(withDm(h, '1\n2\n3').ok, h.split(' — ')[0] + ' is skipped by the DM reader');
});
// The notices as generated are not read as replies either.
[nf, nb, np, nd, nv1, nv2, nu].forEach(function (n) { assert.ok(withDm(n.text.split('\n')[0], n.text.split('\n').slice(1).join('\n')).ok, n.text.split('\n')[0]); });

console.log('status: OK');
