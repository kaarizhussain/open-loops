/* tools/window.js: the start of the lookback window as the Slack `oldest` value.
 *
 * Local midnight, <days> days before today, in the reader's offset. A run used to work this out with `node -e`, which a run nobody is
 * watching cannot do (it stops at any command it was not allowed), and which is where an off-by-a-day bound comes from.
 */
var assert = require('assert');
var cp = require('child_process');
var path = require('path');
var { windowStart } = require('../tools/window.js');

var iso = function (s) { return new Date(s * 1000).toISOString(); };

// 21 days before 2026-11-22 is 2026-11-01; local midnight at UTC-5 is 05:00 UTC.
assert.strictEqual(iso(windowStart('2026-11-22', 21, -300)), '2026-11-01T05:00:00.000Z');
// The sign of the offset matters in both directions.
assert.strictEqual(iso(windowStart('2026-11-22', 21, -240)), '2026-11-01T04:00:00.000Z');
assert.strictEqual(iso(windowStart('2026-11-22', 21, 60)), '2026-10-31T23:00:00.000Z', 'east of UTC, local midnight is the evening before in UTC');
assert.strictEqual(windowStart('2026-11-22', 0, 0), Date.UTC(2026, 10, 22) / 1000, 'no window: today at midnight');
assert.strictEqual(iso(windowStart('2026-03-01', 1, 0)), '2026-02-28T00:00:00.000Z', 'across a month end');
assert.strictEqual(iso(windowStart('2028-03-01', 1, 0)), '2028-02-29T00:00:00.000Z', 'and a leap day');

['2026-11-31', '2026-13-01', '11/22/2026', '', undefined, '2026-11-22T00:00'].forEach(function (bad) {
  assert.throws(function () { windowStart(bad, 21, -300); }, /--today/, 'not a date: ' + bad);
});
[-1, 3651, NaN, '21'].forEach(function (bad) { assert.throws(function () { windowStart('2026-11-22', bad, -300); }, /--days/, 'bad days: ' + bad); });
[NaN, 1441, '-300', undefined].forEach(function (bad) { assert.throws(function () { windowStart('2026-11-22', 21, bad); }, /--tz/, 'bad tz: ' + bad); });

// As a command: one number on one line, exit 0; a bad argument exits 2 and prints nothing to stdout.
var run = function (args) { return cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'window.js')].concat(args), { encoding: 'utf8' }); };
var ok = run(['--today', '2026-11-22', '--days', '21', '--tz', '-300']);
assert.strictEqual(ok.status, 0);
assert.strictEqual(ok.stdout, '1793509200\n', 'exactly the number, nothing else');
var bad = run(['--today', '2026-11-31', '--days', '21', '--tz', '-300']);
assert.strictEqual(bad.status, 2);
assert.strictEqual(bad.stdout, '');
assert.ok(/--today is not a real date/.test(bad.stderr), bad.stderr);
assert.strictEqual(run([]).status, 2, 'no arguments at all');
assert.strictEqual(run(['--today', '2026-11-22', '--days', '', '--tz', '-300']).status, 2, 'an empty --days is not 0');

console.log('window: OK');
