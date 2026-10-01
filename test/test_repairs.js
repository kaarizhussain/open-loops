/* Repair procedures and retry notices.
 *
 *  1. SKILL.md has a procedure for "fix the Open Loops configuration" and one for "check the Open Loops ledger" (explicit request only, preserve before replacing,
 *     validate the copy read-only first), and slack-run.js --check-ledger is the read-only validation.
 *  2. A replaced attempt's failure notice is suppressed only when a later attempt for the same date has a confirmed delivery.
 *  3. The partial-delivery notice does not offer a retry as if nothing were in the DM.
 *  4. tools/alerts.js exits 3 for an unusable config; a failed alerts write removes only its own temp file; tools/report.js refuses a bad --failed with exit 1.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');
var cli = require('../tools/status.js');
var S = require('../src/status.js');
var A = require('../src/alerts.js');
var { main } = require('../slack-run.js');

var ROOT = path.join(__dirname, '..'), NL = String.fromCharCode(10), ME = 'alex@example.com';
var tmp = function () { return fs.mkdtempSync(path.join(os.tmpdir(), 'ol-repair-')); };
var node = function (script, args) { return cp.spawnSync(process.execPath, [path.join(ROOT, script)].concat(args), { encoding: 'utf8', cwd: ROOT }); };
var skill = fs.readFileSync(path.join(ROOT, 'skills', 'open-loops', 'SKILL.md'), 'utf8').split(String.fromCharCode(13)).join('');
var flat = skill.replace(/\s+/g, ' ');

/* ============================== 1. the procedures ============================== */
var cfgSection = skill.slice(skill.indexOf('## When the configuration is unusable'), skill.indexOf('## When the ledger cannot be read'));
var ledSection = skill.slice(skill.indexOf('## When the ledger cannot be read'), skill.indexOf('## Midday check'));
assert.ok(cfgSection.length > 200 && ledSection.length > 200, 'both procedures exist');
assert.ok(/"fix the Open Loops configuration"/.test(cfgSection) && /"check the Open Loops ledger"/.test(ledSection), 'under the phrases the notices tell the user to say');
assert.ok(/--check-config/.test(cfgSection) && /Change only the setting the reason names/.test(cfgSection) && /Never delete or\s+recreate the file/.test(cfgSection));
assert.ok(cfgSection.replace(/\s+/g, ' ').indexOf('When it prints `Config OK.`, say: "The configuration check passes. The next scheduled run will use it." Do not run a digest unless they ask for one.') > -1, 'after Config OK it promises only that the next run will use it');
assert.ok(!/run normally|will run/i.test(cfgSection), 'and not that the digest will run normally');
var led = ledSection.replace(/\s+/g, ' ');
assert.ok(/you change nothing on your own/.test(led) && /Replace or move it only when they explicitly ask/.test(led), 'a ledger is only replaced or moved when the user explicitly asks');
assert.ok(/--check-ledger <the copy>` must print `Ledger OK\.`/.test(led), 'a copy is validated read-only first');
assert.ok(led.indexOf('copy the current file beside itself under a new dated name') > -1 && /never over an existing file/.test(led) && led.indexOf('only then put the copy in its place') > -1, 'the current file is preserved before anything replaces it');
assert.ok(led.indexOf('Move the current file aside under a dated name (never delete it)') > -1);
assert.ok(led.indexOf('starting fresh loses access to the old corrections and restore history, and that moving the file aside keeps them for recovery') > -1);
assert.ok(/Do not move, delete, recreate or repair the file, and do not run a digest/.test(led));
assert.ok(flat.indexOf('Never move aside, delete, recreate or repair a ledger you cannot read on your own.') > -1 && flat.indexOf('Only when they explicitly ask, do it as "When the ledger cannot be read" says.') > -1, 'the older rule points at it');
assert.ok(flat.indexOf('A configuration problem (exit 3) or an unreadable ledger (exit 4) is `runner`.') > -1, 'and the report step says which stage those are');

// --check-ledger: read-only, and strict about what a ledger is.
var dir = tmp(), cfg = path.join(dir, 'c.json'), ledger = path.join(dir, 'ledger.json'), inp = path.join(dir, 'in.json');
fs.writeFileSync(cfg, JSON.stringify({ you: ME, selfDm: 'U0EXAMPLE001', tzOffset: 0, spotCheck: 0, ledger: ledger, channels: { include: ['#ops'] } }));
var chat = '=== Message from Lena Borg <lena@vf.example> (U0EXAMPLE002) at 1790000000.000000 UTC ===' + NL + 'Message TS: 1790000000.000000' + NL + 'Please send the deck Thursday Oct 1.' + NL +
  '=== Message from Sam Okafor <sam@acme.example> (U0EXAMPLE003) at 1790000100.000000 UTC ===' + NL + 'Message TS: 1790000100.000000' + NL + 'Please send the deck Thursday Oct 1.';
fs.writeFileSync(inp, JSON.stringify({ today: '2026-10-01', conversations: [{ channel: '#ops', members: [], text: chat, complete: true }], dm: { channel: 'D0', text: '' } }));
assert.strictEqual(node('slack-run.js', [inp, '--config', cfg]).status, 0);
var good = fs.readFileSync(ledger, 'utf8'), names = fs.readdirSync(dir).sort().join(',');
var mtimeBefore = fs.statSync(ledger).mtimeMs;
var ok = node('slack-run.js', ['--check-ledger', ledger]);
assert.strictEqual(ok.status, 0, ok.stderr); assert.strictEqual(ok.stdout.trim(), 'Ledger OK.');
assert.strictEqual(fs.readFileSync(ledger, 'utf8'), good, 'nothing was written');
assert.strictEqual(fs.statSync(ledger).mtimeMs, mtimeBefore, 'not even touched');
assert.strictEqual(fs.readdirSync(dir).sort().join(','), names, 'nor created beside it');
var bad = function (name, content, re) {
  var f = path.join(dir, name);
  if (content !== null) fs.writeFileSync(f, content);
  var r = node('slack-run.js', ['--check-ledger', f]);
  assert.strictEqual(r.status, 4, name + ': ' + r.stdout + r.stderr);
  assert.ok(re.test(r.stderr), name + ': ' + r.stderr);
  if (content !== null) assert.strictEqual(fs.readFileSync(f, 'utf8'), content, name + ': untouched');
};
bad('missing.json', null, /Ledger at .*missing\.json does not exist\./);          // the store reads a missing file as a first run: an empty path must not pass
bad('garbage.json', '{ not a ledger', /Ledger at .* could not be read/);
bad('wrong-shape.json', '{"rows":"x"}', /Ledger at .* could not be read/);
bad('empty.json', '', /Ledger at .* could not be read/);
bad('bad-restore.json', JSON.stringify(Object.assign(JSON.parse(good), { restoreLog: { deadbeef: null } })), /restoreLog entry "deadbeef" is not valid/);
var noSalt = JSON.parse(good); delete noSalt.identitySalt;
bad('no-salt.json', JSON.stringify(noSalt), /holds person identifiers but no identity salt/);
var rno = node('slack-run.js', ['--check-ledger']);
assert.strictEqual(rno.status, 4); assert.ok(/--check-ledger needs the path of the ledger file to check\./.test(rno.stderr));
var rdir = node('slack-run.js', ['--check-ledger', dir]);
assert.strictEqual(rdir.status, 4); assert.ok(/does not exist/.test(rdir.stderr), 'a folder is not a ledger');

/* ============================== 2. a replaced attempt's notice ============================== */
var failing = function (fn) {
  var realW = fs.writeFileSync;
  fs.writeFileSync = function (f) { if (/\.tmp$/.test(String(f))) { var e = new Error('EACCES: simulated'); e.code = 'EACCES'; throw e; } return realW.apply(fs, arguments); };
  try { return fn(); } finally { fs.writeFileSync = realW; }
};
var caught = function (fn) { try { fn(); } catch (e) { return e; } assert.fail('expected a failure'); };
var attempts = function (cfgDir) {
  var c = path.join(cfgDir, 'c.json');
  return {
    cfg: c,
    begin: function (hhmm, day) { return cli.main(['--begin', '--today', day || '2026-10-01', '--now', (day || '2026-10-01') + 'T' + hhmm, '--config', c]).match(/ATTEMPT ([0-9a-f]+)/)[1]; },
    end: function (id, flags, hhmm, day) { return cli.main(['--end', '--attempt', id, '--now', (day || '2026-10-01') + 'T' + hhmm, '--config', c].concat(flags), function () {}); }
  };
};
var FAIL = ['--brief', 'not_attempted', '--details', 'not_attempted', '--verified', 'no', '--failed', 'build'];
var OK = ['--brief', 'posted', '--details', 'posted', '--verified', 'yes', '--ref', 'abcd'];
var COVERED = 'ATTEMPT REPLACED — a later attempt for 2026-10-01 delivered (ref abcd), so no failure notice is needed.';
// A later attempt delivered: nothing to tell.
var d1 = tmp(), a1 = attempts(d1), first = a1.begin('18:00'), second = a1.begin('18:30');
assert.strictEqual(a1.end(second, OK, '19:00'), 'DELIVERED — recorded.');
assert.strictEqual(a1.end(first, FAIL, '19:05'), COVERED, 'the replaced attempt\'s failure notice is not needed');
assert.deepStrictEqual(S.load(d1).superseded, [], 'and it is no longer listed');
assert.strictEqual(S.load(d1).delivered.ref, 'abcd', 'the delivery is as it was');
assert.throws(function () { a1.end(first, FAIL, '19:06'); }, /no attempt .* is open/, 'and it is ended once');
// A delivery from BEFORE the replaced attempt began does not qualify.
var d2 = tmp(), a2 = attempts(d2), early = a2.begin('09:00');
a2.end(early, OK, '09:30');
var r1 = a2.begin('18:00'), r2 = a2.begin('18:30');
var notNeeded = a2.end(r1, FAIL, '19:00');
assert.ok(/^OPEN LOOPS NOT RUN — for 2026-10-01/.test(notNeeded), 'an earlier delivery does not cover it: ' + notNeeded);
// A delivery for another date does not either.
var d3 = tmp(), a3 = attempts(d3), p1 = a3.begin('18:00'), p2 = a3.begin('18:30');
fs.writeFileSync(path.join(d3, 'status.json'), JSON.stringify(Object.assign(JSON.parse(fs.readFileSync(path.join(d3, 'status.json'), 'utf8')), { delivered: { date: '2026-10-02', at: '2026-10-01T23:00:00.000Z', ref: 'abcd' } })));
assert.ok(/^OPEN LOOPS NOT RUN/.test(a3.end(p1, FAIL, '19:00')), 'another date: no');
// No delivery at all: the notice, as before.
var d4 = tmp(), a4 = attempts(d4), q1 = a4.begin('18:00'); a4.begin('18:30');
assert.ok(/^OPEN LOOPS NOT RUN/.test(a4.end(q1, FAIL, '19:00')));
// A delivery that began before the replaced attempt but ended after it: judged by when it was confirmed, which is later: covered. One confirmed before it began is not.
var d5 = tmp(), a5 = attempts(d5), s1 = a5.begin('18:00'), s2 = a5.begin('18:30');
fs.writeFileSync(path.join(d5, 'status.json'), JSON.stringify(Object.assign(JSON.parse(fs.readFileSync(path.join(d5, 'status.json'), 'utf8')), { delivered: { date: '2026-10-01', at: new Date(2026, 9, 1, 17, 59).toISOString(), ref: 'abcd' } })));
assert.ok(/^OPEN LOOPS NOT RUN/.test(a5.end(s1, FAIL, '19:00')), 'confirmed a minute before it began: not covered');
// A delivery with no recorded reference is still a delivery.
var d6 = tmp(), a6 = attempts(d6), t1 = a6.begin('18:00'); a6.begin('18:30');
fs.writeFileSync(path.join(d6, 'status.json'), JSON.stringify(Object.assign(JSON.parse(fs.readFileSync(path.join(d6, 'status.json'), 'utf8')), { delivered: { date: '2026-10-01', at: new Date(2026, 9, 1, 19, 0).toISOString() } })));
assert.strictEqual(a6.end(t1, FAIL, '19:05'), 'ATTEMPT REPLACED — a later attempt for 2026-10-01 delivered, so no failure notice is needed.');
// If it cannot be recorded, the answer is still given, with the persistence failure.
var d7 = tmp(), a7 = attempts(d7), u1 = a7.begin('18:00'), u2 = a7.begin('18:30'); a7.end(u2, OK, '19:00');
var e7 = failing(function () { return caught(function () { a7.end(u1, FAIL, '19:05'); }); });
assert.strictEqual(e7.exitCode, 5); assert.strictEqual(e7.stdout, COVERED);
assert.strictEqual(e7.message, 'status: could not write status.json (EACCES). It was not changed.');
// A replaced attempt that was itself delivered is still recorded.
var d8 = tmp(), a8 = attempts(d8), v1 = a8.begin('18:00'); a8.begin('18:30');
assert.ok(/^DELIVERED — recorded\. \(Attempt/.test(a8.end(v1, OK, '19:00')));

/* ============================== 3. the partial-delivery notice ============================== */
var AGAIN = 'The brief is already in your DM. If you ask for another run, it will post another numbered list. Reply in the thread of the list you mean.';
['details', 'verify'].forEach(function (cause) {
  var n = S.notice({ outcome: 'partial', cause: cause, date: '2026-10-01', details: cause === 'verify' ? 'posted' : 'rejected', brief: 'posted' }, null);
  assert.strictEqual(n.where, 'thread');
  assert.strictEqual(n.text.split(NL).pop(), AGAIN, cause + ': the last line');
  assert.ok(!/To try again now|posts a fresh digest/.test(n.text), cause + ': no offer of a fresh digest');
});
assert.ok(/To try again now, tell your assistant "run Open Loops"/.test(S.notice({ outcome: 'not_delivered', cause: 'build', date: '2026-10-01' }, null).text), 'a run that posted nothing still offers the retry that can help');

/* ============================== 4. exit codes and temp files ============================== */
var ad = tmp();
fs.writeFileSync(path.join(ad, 'c.json'), '{ not json');
var ra = node('tools/alerts.js', ['--status', '--config', path.join(ad, 'c.json')]);
assert.strictEqual(ra.status, 3, 'an unusable config is exit 3 here too: ' + ra.stderr);
assert.ok(/^alerts: Config at .* could not be read/.test(ra.stderr));
fs.writeFileSync(path.join(ad, 'c.json'), 'null');
assert.strictEqual(node('tools/alerts.js', ['--status', '--config', path.join(ad, 'c.json')]).status, 3, 'a config that is not an object too');
fs.writeFileSync(path.join(ad, 'c.json'), JSON.stringify({ you: ME, selfDm: 'U1' }));
assert.strictEqual(node('tools/alerts.js', ['--status', '--config', path.join(ad, 'c.json')]).status, 0);
assert.strictEqual(node('tools/alerts.js', ['--bogus', '--config', path.join(ad, 'c.json')]).status, 1, 'and a mistake in the call stays exit 1');
// A failed alerts write removes its own temp file and not another operation's.
var tw = tmp(); fs.writeFileSync(path.join(tw, 'alerts-baseline.next.json.1.aaaaaa.tmp'), 'another operation');
var realW = fs.writeFileSync, failed;
fs.writeFileSync = function (f) { if (/\.tmp$/.test(String(f)) && !/\.1\.aaaaaa\.tmp$/.test(String(f))) { realW.call(fs, f, 'partial'); var e = new Error('EACCES: simulated'); e.code = 'EACCES'; throw e; } return realW.apply(fs, arguments); };
try { failed = caught(function () { A.stageBaseline(tw, [], '2026-10-01', 'abcd'); }); } finally { fs.writeFileSync = realW; }
assert.ok(failed.code === 'EACCES' || /EACCES/.test(failed.message));
assert.deepStrictEqual(fs.readdirSync(tw).filter(function (f) { return /\.tmp$/.test(f); }), ['alerts-baseline.next.json.1.aaaaaa.tmp'], 'only its own file was removed');
// report.js: a refused stage is exit 1; the report itself never fails the run.
var rp = tmp(); fs.writeFileSync(path.join(rp, 'c.json'), JSON.stringify({ you: ME, selfDm: 'U1' }));
var rbad = node('tools/report.js', ['--send', '--failed', 'config', '--config', path.join(rp, 'c.json')]);
assert.strictEqual(rbad.status, 1, rbad.stdout + rbad.stderr);
assert.strictEqual(rbad.stderr.trim(), 'report: --failed takes one of: pull, fetch_slack, fetch_calendar, runner, post, readback');
var rok = node('tools/report.js', ['--send', '--failed', 'runner', '--config', path.join(rp, 'c.json')]);
assert.strictEqual(rok.status, 0, rok.stderr);
assert.ok(/^reports: /.test(rok.stdout), 'the stage SKILL.md names for config and ledger failures is accepted: ' + rok.stdout);

console.log('repairs and retry notices: OK');
