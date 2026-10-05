/* Where the ledger may be (adversarial review 2026-10-05, Codex finding 1 and the ledger pass's B1/B4).
 *
 *   1. A ledger named like a file Open Loops writes beside the config (status.json, status.staged.json, alerts*.json, restores.json, the report
 *      queue, or the config itself) was accepted by --check-config, then rewritten by the tool that owns the name: its rows and verdicts gone.
 *      It is refused (exit 3) before anything writes, by the runner and by the tools that run before it. Any spelling of the same file counts.
 *   2. A relative "ledger" meant the working directory, so the same config run from another folder started a new, empty ledger. It now means
 *      beside the config. A relative ledger that is still in the working directory but not beside the config is refused, with the way out,
 *      rather than abandoned silently.
 * Everything runs in temporary directories with synthetic data.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');

var ROOT = path.join(__dirname, '..');
var node = function (script, args, cwd) { return cp.spawnSync(process.execPath, [path.join(ROOT, script)].concat(args), { encoding: 'utf8', cwd: cwd || os.tmpdir() }); };
var fresh = function () { return fs.mkdtempSync(path.join(os.tmpdir(), 'ol-ledgerpath-')); };
var CFG = 'openloops.config.json';
var write = function (dir, ledger) {
  fs.writeFileSync(path.join(dir, CFG), JSON.stringify({ you: 'alex@example.com', useCalendar: false, spotCheck: 0, ledger: ledger, channels: { include: ['#ops'] } }));
  fs.writeFileSync(path.join(dir, 'input.json'), JSON.stringify({ today: '2026-10-05', conversations: [{ channel: '#ops', messages: [], complete: true }], dm: { messages: [] }, dmLookup: 'searched_none' }));
};
var wording = function (value, name) {
  return 'Config is unusable: "ledger" (' + value + ') is the same file as the ' + name + ' file Open Loops also writes. Choose another ledger file name. Fix the configuration before fetching or running a digest.';
};

/* ------------------------------ 1. reserved names, every spelling ------------------------------ */
var RESERVED = require('../src/config.js').RESERVED.concat([CFG]);
assert.ok(RESERVED.indexOf('status.staged.json') > -1 && RESERVED.indexOf('alerts-baseline.next.json') > -1, 'the staged files are reserved');
RESERVED.forEach(function (name) {
  var dir = fresh(), target = path.join(dir, name);
  var spellings = [name, './' + name, 'sub/../' + name, target];
  if (process.platform === 'win32') spellings.push(name.toUpperCase(), target.replace(/\\/g, '/'));
  spellings.forEach(function (spelling) {
    write(dir, spelling);
    if (name !== CFG) fs.writeFileSync(target, 'a ledger that must survive');
    var before = fs.readFileSync(target, 'utf8');
    var check = node('slack-run.js', ['--check-config', '--config', path.join(dir, CFG)]);
    assert.strictEqual(check.status, 3, name + ' as "' + spelling + '": --check-config refuses');
    assert.strictEqual(check.stderr.trim(), 'open-loops: ' + wording(spelling, name).replace(/ Fix the configuration.*$/, '') + ' Fix the configuration before fetching or running a digest.', 'with the agreed wording');
    var run = node('slack-run.js', [path.join(dir, 'input.json'), '--config', path.join(dir, CFG)]);
    assert.strictEqual(run.status, 3, name + ' as "' + spelling + '": the run refuses');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), before, name + ' as "' + spelling + '": nothing was written over it');
  });
});

// The tools that run BEFORE the runner's config check refuse too: status.js --begin is the first step of a run.
var dir = fresh();
write(dir, 'status.json');
fs.writeFileSync(path.join(dir, 'status.json'), 'the ledger');
var begin = node('tools/status.js', ['--begin', '--today', '2026-10-05', '--config', path.join(dir, CFG)]);
assert.strictEqual(begin.status, 3, 'status.js --begin refuses a ledger named status.json');
assert.strictEqual(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'), 'the ledger', 'and does not overwrite it');
write(dir, 'alerts-baseline.json');
fs.writeFileSync(path.join(dir, 'alerts-baseline.json'), 'the ledger');
var base = node('tools/alerts.js', ['--baseline', '--ref', 'abcd', '--config', path.join(dir, CFG)]);
assert.strictEqual(base.status === 3 || /Config is unusable/.test(base.stderr + base.stdout), true, 'alerts.js --baseline refuses a ledger named alerts-baseline.json: ' + base.stderr + base.stdout);
assert.strictEqual(fs.readFileSync(path.join(dir, 'alerts-baseline.json'), 'utf8'), 'the ledger', 'and does not overwrite it');

// Ordinary names are fine.
['ledger.json', 'my-ledger.json', 'sub/ledger.json', 'ledger.json.bak'].forEach(function (name) {
  var d = fresh(); write(d, name);
  if (name.indexOf('/') > -1) fs.mkdirSync(path.join(d, 'sub'));
  var r = node('slack-run.js', [path.join(d, 'input.json'), '--config', path.join(d, CFG)]);
  assert.strictEqual(r.status, 0, name + ' is a usable ledger name: ' + r.stderr);
});

/* ------------------------------ 2. a relative ledger is beside the config ------------------------------ */
var cfgDir = fresh(), elsewhere = fresh();
write(cfgDir, 'ledger.json');
var run1 = node('slack-run.js', [path.join(cfgDir, 'input.json'), '--config', path.join(cfgDir, CFG)], elsewhere);
assert.strictEqual(run1.status, 0, 'run from another folder works: ' + run1.stderr);
assert.ok(fs.existsSync(path.join(cfgDir, 'ledger.json')), 'the ledger is made beside the config');
assert.ok(!fs.existsSync(path.join(elsewhere, 'ledger.json')), 'not in the folder the run was started from');
// A second run from yet another folder finds the same ledger, and its verdicts.
var saved = JSON.parse(fs.readFileSync(path.join(cfgDir, 'ledger.json'), 'utf8'));
saved.rows = [['owed_by_us|#ops|2026-10-01|synthetic', '2026-10-01', '2026-10-01', '', 'owed_by_us', '', 'I will send the synthetic contract.', 'x']];
fs.writeFileSync(path.join(cfgDir, 'ledger.json'), JSON.stringify(saved));
var third = fresh();
// A later day: a second run on the same day would start from the day's snapshot, not from the rows just put in.
fs.writeFileSync(path.join(cfgDir, 'input2.json'), JSON.stringify({ today: '2026-10-06', conversations: [{ channel: '#ops', messages: [], complete: true }], dm: { messages: [] }, dmLookup: 'searched_none' }));
assert.strictEqual(node('slack-run.js', [path.join(cfgDir, 'input2.json'), '--config', path.join(cfgDir, CFG)], third).status, 0);
assert.ok(JSON.parse(fs.readFileSync(path.join(cfgDir, 'ledger.json'), 'utf8')).rows.some(function (r) { return r[7] === 'x'; }), 'the verdict in it is still there');

// MIGRATION: a relative ledger that exists in the working directory and not beside the config is not abandoned silently.
var cfg2 = fresh(), cwd2 = fresh();
write(cfg2, 'ledger.json');
fs.writeFileSync(path.join(cwd2, 'ledger.json'), JSON.stringify(saved));
var mig = node('slack-run.js', [path.join(cfg2, 'input.json'), '--config', path.join(cfg2, CFG)], cwd2);
assert.strictEqual(mig.status, 3, 'refused, exit 3: ' + mig.stderr);
assert.ok(/now means the file beside the config/.test(mig.stderr) && /Move it next to the config, or set "ledger" to its full path\./.test(mig.stderr), 'and says what to do');
assert.ok(!fs.existsSync(path.join(cfg2, 'ledger.json')), 'no empty ledger was started beside the config');
assert.strictEqual(fs.readFileSync(path.join(cwd2, 'ledger.json'), 'utf8'), JSON.stringify(saved), 'and the old one is untouched');
// An absolute ledger is unaffected; so is --ledger on the command line, which is relative to where it was typed.
var cfg3 = fresh(), abs = path.join(fresh(), 'abs-ledger.json');
write(cfg3, abs);
assert.strictEqual(node('slack-run.js', [path.join(cfg3, 'input.json'), '--config', path.join(cfg3, CFG)], fresh()).status, 0);
assert.ok(fs.existsSync(abs), 'an absolute ledger is used where it is');
var cfg4 = fresh(), cwd4 = fresh();
write(cfg4, 'ledger.json');
assert.strictEqual(node('slack-run.js', [path.join(cfg4, 'input.json'), '--config', path.join(cfg4, CFG), '--ledger', 'flag-ledger.json'], cwd4).status, 0);
assert.ok(fs.existsSync(path.join(cwd4, 'flag-ledger.json')) && !fs.existsSync(path.join(cfg4, 'flag-ledger.json')), '--ledger is relative to the working directory');

console.log('ledger path: OK');
