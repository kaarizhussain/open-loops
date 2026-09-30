/* A run that cannot start must still be recorded, and its notice must say only what is true.
 *
 * The bug: the scheduled run checked the configuration BEFORE it began an attempt, so an unusable configuration left no record and no notice,
 * and the owner saw an empty DM. And the one failure notice for "the runner failed" said "run Open Loops again", which cannot help when the
 * configuration or the ledger is what is broken, and said nothing about what had and had not been fetched.
 *
 * Now `--begin` and `--end` never read the configuration; `--failed config` (with --fetched yes|no) and `--failed ledger` are stages of their
 * own; the runner exits 3 for a configuration it cannot use and 4 for a ledger it cannot read; a damaged ledger is never touched.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');
var S = require('../src/status.js');
var cli = require('../tools/status.js');

var ROOT = path.join(__dirname, '..');
var tmp = function () { return fs.mkdtempSync(path.join(os.tmpdir(), 'ol-stages-')); };
var at = function (s) { return S.parseNow(s); };
var NL = String.fromCharCode(10);
var run = function (args, cwd) { return cp.spawnSync(process.execPath, args, { cwd: cwd || ROOT, encoding: 'utf8' }); };

/* ------------------------------ 1. begin and end work when the configuration is the thing that is broken ------------------------------ */
var begun = function (d, cfgText) {
  var cfg = path.join(d, 'openloops.config.json');
  if (cfgText != null) fs.writeFileSync(cfg, cfgText);
  var out = cli.main(['--begin', '--today', '2026-10-01', '--config', cfg], null), id = out.match(/ATTEMPT ([0-9a-f]+)/)[1];
  return { cfg: cfg, id: id };
};
var end = function (b, flags, now) { return cli.main(['--end', '--attempt', b.id, '--config', b.cfg].concat(flags), function () {}); };

var CONFIG_NOT_FETCHED = ['--brief', 'not_attempted', '--details', 'not_attempted', '--verified', 'no', '--failed', 'config', '--fetched', 'no'];

['{ this is not json', null].forEach(function (cfgText) {
  var d = tmp(), b = begun(d, cfgText);
  var n = end(b, CONFIG_NOT_FETCHED);
  assert.ok(/^OPEN LOOPS NOT RUN — for 2026-10-01/.test(n), 'a notice is issued even though the config cannot be read: ' + n);
  var s = S.load(d);
  assert.strictEqual(s.attempt.outcome, 'not_delivered');
  assert.strictEqual(s.attempt.cause, 'config');
  assert.strictEqual(s.attempt.fetched, false);
});

/* ------------------------------ 2. the notices say only what is true at that stage ------------------------------ */
var EMPTY = 'An empty DM today does not mean nothing is outstanding.';
var d1 = tmp(), b1 = begun(d1, '{ not json');
var cfgNotice = end(b1, CONFIG_NOT_FETCHED);
assert.strictEqual(cfgNotice.split(NL).slice(0, 2).join(NL),
  'OPEN LOOPS NOT RUN — for 2026-10-01' + NL +
  'Open Loops\' configuration can\'t be used, so nothing was fetched and nothing was posted. Running it again will not help until the configuration is fixed — ' +
  'tell your assistant "fix the Open Loops configuration". ' + EMPTY);
assert.ok(/^No verified delivery recorded by status tracking yet\.$/m.test(cfgNotice), 'and the last-delivered line is still there: ' + cfgNotice);
assert.ok(!/run Open Loops/.test(cfgNotice), 'a retry is not offered: it cannot help');

// A configuration found unusable AFTER Slack was fetched must not claim nothing was fetched: the claim depends on the stage, not on the exit code.
var d2 = tmp(), b2 = begun(d2, '{ not json');
var late = end(b2, ['--brief', 'not_attempted', '--details', 'not_attempted', '--verified', 'no', '--failed', 'config', '--fetched', 'yes']);
assert.ok(!/nothing was fetched/i.test(late), 'found after the fetch, it does not say nothing was fetched: ' + late);
assert.ok(/^Slack was fetched, but Open Loops' configuration can't be used, so today's digest was not built\. Nothing was posted\. Running it again will not help/m.test(late), late);
assert.strictEqual(S.load(d2).attempt.fetched, true);

// The assistant must say which; a config failure with no --fetched records nothing and says why.
var d3 = tmp(), b3 = begun(d3, '{ not json');
assert.throws(function () { end(b3, ['--brief', 'not_attempted', '--details', 'not_attempted', '--verified', 'no', '--failed', 'config']); },
  /--failed config needs --fetched yes\|no/);
assert.strictEqual(S.load(d3).attempt.outcome, 'started', 'nothing was recorded by the refused call');
assert.throws(function () { end(b3, ['--brief', 'not_attempted', '--details', 'not_attempted', '--verified', 'no', '--failed', 'config', '--fetched', 'maybe']); }, /--fetched yes\|no/);

var d4 = tmp(), b4 = begun(d4, '{}');
var ledgerNotice = end(b4, ['--brief', 'not_attempted', '--details', 'not_attempted', '--verified', 'no', '--failed', 'ledger']);
assert.strictEqual(ledgerNotice.split(NL).slice(0, 2).join(NL),
  'OPEN LOOPS NOT RUN — for 2026-10-01' + NL +
  'Slack was fetched, but the ledger file can\'t be read, so today\'s digest was not built. Nothing was posted, and the ledger was left exactly as it is. ' +
  'Running it again will not help until the ledger is restored — tell your assistant "check the Open Loops ledger". ' + EMPTY);
assert.ok(!/run Open Loops/.test(ledgerNotice), 'no retry for a ledger either');
assert.strictEqual(S.load(d4).attempt.cause, 'ledger');
assert.strictEqual(S.load(d4).attempt.fetched, true, 'the ledger is read after the fetch');

// The other stages are unchanged: a build failure still offers the retry that can help.
var d5 = tmp(), b5 = begun(d5, '{}');
var build = end(b5, ['--brief', 'not_attempted', '--details', 'not_attempted', '--verified', 'no', '--failed', 'build']);
assert.ok(/Slack was fetched, but processing failed/.test(build) && /run Open Loops/.test(build), build);

// A delivered run that names a stage does not become a failure.
assert.deepStrictEqual(S.classify({ brief: 'posted', details: 'posted', verified: true, failed: 'ledger' }), { outcome: 'delivered' });
// And a run that tried to post is not a config or ledger failure whatever it was called.
assert.strictEqual(S.classify({ brief: 'rejected', details: 'not_attempted', verified: false, failed: 'config' }).cause, 'post');

/* ------------------------------ 3. status lines agree with the notice ------------------------------ */
var line = function (d) { var v = S.view(d, {}, null, at('2026-10-01T23:00'), {}); return v.slice(v.indexOf('Last attempt'), v.indexOf('Next run')); };
assert.ok(/the configuration can't be used\. Nothing was fetched or posted\./.test(line(d1)), line(d1));
assert.ok(/Slack was fetched, but the configuration can't be used\. Nothing was posted\./.test(line(d2)), line(d2));
assert.ok(/Slack was fetched, but the ledger file can't be read\. Nothing was posted\./.test(line(d4)), line(d4));
assert.ok(!/Slack could not be fetched/.test(line(d1) + line(d4)), 'neither is called a fetch failure');

/* ------------------------------ 4. the notice cannot be posted: the failure stays recorded, and what happened to the notice is said ------------------------------ */
['posted', 'rejected', 'unknown', 'not_attempted'].forEach(function (result) {
  var d = tmp(), b = begun(d, '{ not json');
  end(b, CONFIG_NOT_FETCHED);
  cli.main(['--notice-result', result, '--attempt', b.id, '--config', b.cfg]);
  var s = S.load(d);
  assert.strictEqual(s.attempt.outcome, 'not_delivered', 'the failure is still recorded after a notice result of ' + result);
  assert.strictEqual(s.attempt.cause, 'config');
  assert.strictEqual(s.attempt.notice, result);
});
var dn = tmp(), bn = begun(dn, '{ not json');
end(bn, CONFIG_NOT_FETCHED);
cli.main(['--notice-result', 'not_attempted', '--attempt', bn.id, '--config', bn.cfg]);
var nl = line(dn);
assert.ok(/No notice was posted: your own DM could not be found to post it in\./.test(nl), nl);
assert.ok(!/A notice was posted/.test(nl), 'and it does not claim one was');
var dp = tmp(), bp = begun(dp, '{ not json');
end(bp, CONFIG_NOT_FETCHED);
assert.throws(function () { cli.main(['--notice-result', 'not_posted', '--attempt', bp.id, '--config', bp.cfg]); }, /--notice-result must be/, 'absence is still not a fact');
assert.strictEqual(S.load(dp).attempt.notice, 'pending', 'and the refused call changed nothing');

/* ------------------------------ 5. exit codes: 3 the configuration, 4 the ledger, 1 anything else ------------------------------ */
var d6 = tmp(), cfg6 = path.join(d6, 'openloops.config.json'), led6 = path.join(d6, 'ledger.json'), in6 = path.join(d6, 'in.json');
var goodCfg = { you: 'alex@example.com', selfDm: 'U0EXAMPLE001', tzOffset: 0, spotCheck: 0, ledger: led6, channels: { include: ['#ops'] } };
fs.writeFileSync(in6, JSON.stringify({ today: '2026-10-01', conversations: [{ channel: '#ops', members: [], text: '', complete: true }], dm: { channel: 'D0', text: '' } }));

fs.writeFileSync(cfg6, JSON.stringify(goodCfg));
assert.strictEqual(run(['slack-run.js', in6, '--config', cfg6]).status, 0, 'a good setup runs');

fs.writeFileSync(cfg6, '{ not json');
var r = run(['slack-run.js', '--check-config', '--config', cfg6]);
assert.strictEqual(r.status, 3, 'check-config on a config that is not JSON: ' + r.stderr);
assert.strictEqual(run(['slack-run.js', in6, '--config', cfg6]).status, 3, 'the same unusable config found at run time is also 3');
fs.writeFileSync(cfg6, JSON.stringify(Object.assign({}, goodCfg, { you: '' })));
assert.strictEqual(run(['slack-run.js', '--check-config', '--config', cfg6]).status, 3, 'a config that is JSON but incomplete');
assert.strictEqual(run(['slack-run.js', in6, '--config', cfg6]).status, 3, 'and found at run time, after the fetch, it is 3 as well');
assert.strictEqual(run(['slack-run.js', '--check-config', '--config', path.join(d6, 'nope.json')]).status, 3, 'a config path that does not exist');

fs.writeFileSync(cfg6, JSON.stringify(goodCfg));
fs.writeFileSync(path.join(d6, 'bad-input.json'), 'not json');
assert.strictEqual(run(['slack-run.js', path.join(d6, 'bad-input.json'), '--config', cfg6]).status, 1, 'an input that is not JSON is neither: 1');
assert.strictEqual(run(['slack-run.js', in6, '--config', cfg6, '--today', 'banana']).status, 1, 'nor is a bad date');

/* ------------------------------ 6. a ledger that cannot be read: exit 4, and it is left exactly as it is ------------------------------ */
var listing = function (d) { return fs.readdirSync(d).sort().join(','); };
[['not JSON', '{ this is not a ledger'], ['JSON but not a ledger', '{"rows":"x"}'], ['an empty file', '']].forEach(function (c) {
  fs.writeFileSync(led6, c[1]);
  var before = fs.readFileSync(led6), names = listing(d6);
  var res = run(['slack-run.js', in6, '--config', cfg6]);
  assert.strictEqual(res.status, 4, c[0] + ': exit 4: ' + res.stderr);
  assert.ok(/Ledger at .* could not be read/.test(res.stderr), c[0] + ': the runner says what is wrong: ' + res.stderr);
  assert.ok(before.equals(fs.readFileSync(led6)), c[0] + ': the ledger is byte-for-byte unchanged');
  assert.strictEqual(listing(d6), names, c[0] + ': nothing was moved aside, copied, or created beside it');
  var chk = run(['slack-run.js', in6, '--config', cfg6, '--check']);
  assert.strictEqual(chk.status, 4, c[0] + ': a midday check reads it the same way');
  assert.ok(before.equals(fs.readFileSync(led6)) && listing(d6) === names, c[0] + ': and leaves it alone');
});

/* ------------------------------ 7. the scheduled run's instructions are in the order that makes this work ------------------------------ */
var skill = fs.readFileSync(path.join(ROOT, 'skills', 'open-loops', 'SKILL.md'), 'utf8').split(String.fromCharCode(13)).join('');
var running = skill.slice(skill.indexOf('## Running the digest'));
var iBegin = running.indexOf('**Begin the attempt.**'), iCheck = running.indexOf('**Check the configuration.**'), iFetch = running.indexOf('**Fetch.**');
assert.ok(iBegin > -1 && iCheck > iBegin && iFetch > iCheck, 'begin the attempt, then check the configuration, then fetch');
assert.ok(/--failed config --fetched no/.test(running) && /--failed ledger/.test(running), 'the stages are named');
assert.ok(/exits with code 3/.test(running) && /3 is the configuration, 4 is the\s+ledger/.test(running), 'the exit codes are explained');
assert.ok(/Never move aside, delete, recreate or repair a ledger you cannot read/.test(running), 'a damaged ledger is never put aside by the run');
assert.ok(/slack_read_user_profile\(\)/.test(running.slice(iCheck, iFetch)), 'the DM comes from the profile when the configuration cannot give it');
assert.ok(/--notice-result/.test(running.slice(iCheck, iFetch)) && /not_attempted/.test(running), 'a notice that cannot be posted is reported, not dropped');

console.log('failure stages: OK');
