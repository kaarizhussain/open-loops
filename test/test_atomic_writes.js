/* Two sessions writing the same state file at once must not throw.
 *
 * Every write was staged through one fixed temp name (file + '.tmp'). When two sessions wrote the same file together — a check
 * started by hand while the scheduled one ran, a catch-up after the app reopened — one renamed the temp file the other was about
 * to rename, and the loser threw ENOENT. That is not the two-writers-one-file state AGENTS.md rules out between different tasks:
 * it is one task overlapping itself, which it documents as possible. The record stays whole either way (writes are renamed into
 * place); the fix is that an overlap no longer kills the run.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');

var ROOT = path.join(__dirname, '..');
var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-atomic-'));
var child = function (kind) {
  var code = kind === 'alerts'
    ? "var A=require(" + JSON.stringify(path.join(ROOT, 'src', 'alerts.js')) + ");for(var i=0;i<400;i++)A.writeBaseline(" + JSON.stringify(dir) + ",[],'2026-10-01');"
    : "var S=require(" + JSON.stringify(path.join(ROOT, 'src', 'status.js')) + ");for(var i=0;i<400;i++)S.setSchedule(" + JSON.stringify(dir) + ",'t','0 18 * * *');";
  return new Promise(function (resolve) {
    var p = cp.spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'ignore', 'pipe'] }), err = '';
    p.stderr.on('data', function (d) { err += d; });
    p.on('close', function (status) { resolve({ status: status, err: err }); });
  });
};
Promise.all(['alerts', 'alerts', 'status', 'status'].map(child)).then(function (rs) {
  rs.forEach(function (r, i) { assert.strictEqual(r.status, 0, 'writer ' + i + ' threw: ' + r.err.split('\n').slice(0, 3).join(' | ')); });
  assert.doesNotThrow(function () { JSON.parse(fs.readFileSync(path.join(dir, 'alerts-baseline.json'), 'utf8')); }, 'and the baseline is whole');
  assert.doesNotThrow(function () { JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8')); }, 'and so is the status record');
  assert.deepStrictEqual(fs.readdirSync(dir).filter(function (f) { return /\.tmp$/.test(f); }), [], 'no staging file is left behind');
  console.log('atomic writes: OK');
}).catch(function (e) { console.error(e); process.exit(1); });
