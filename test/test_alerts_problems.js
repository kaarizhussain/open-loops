/* An alerts setting that claims to be on and cannot be used says why, in `--status` and in `--which`. It used to say a plain "Alerts off." with no reason
 * (and `--which` told the checks task "alerts are off, so this task has nothing to do"), so a hand-edited "times" list looked like alerts had never been
 * set up. Nothing ever says alerts are "on" unless the consent record is valid.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var A = require('../src/alerts.js');
var cli = require('../tools/alerts.js');

var CONSENTED = '2026-09-29T20:00:00Z';
var d = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-alertp-')), cfgPath = path.join(d, 'c.json');
var put = function (alerts) { fs.writeFileSync(cfgPath, JSON.stringify(alerts === undefined ? { you: 'a@b.co' } : { you: 'a@b.co', alerts: alerts })); };
var status = function () { return cli.main(['--status', '--config', cfgPath]); };
var which = function () { return cli.main(['--which', '--now', '2026-09-30T12:05', '--config', cfgPath]); };
var good = function (times) { return { delivery: 'dm', consentedAt: CONSENTED, times: times }; };

var CASES = [
  [good(['15:00', '12:00']), '"times" must be in ascending order (got 15:00, 12:00)'],
  [good(['12:00', '17:30']), '"17:30" in "times" is outside the allowed window (08:00 up to, not including, 17:00)'],
  [good(['07:30']), '"07:30" in "times" is outside the allowed window (08:00 up to, not including, 17:00)'],
  [good(['25:99']), '"25:99" in "times" is not a valid HH:MM time'],
  [good(['noon']), '"noon" in "times" is not a valid HH:MM time'],
  [good([]), '"times" must be a list of one to three HH:MM times'],
  [good(['09:00', '10:00', '11:00', '12:00']), '"times" must be a list of one to three HH:MM times'],
  [good('12:00'), '"times" must be a list of one to three HH:MM times'],
  [{ delivery: 'dm' }, 'there is no valid consent record ("consentedAt")'],
  [{ delivery: 'dm', consentedAt: 'yesterday' }, 'there is no valid consent record ("consentedAt")'],
  [{ delivery: 'desktop', consentedAt: CONSENTED }, '"delivery" is "desktop", and only "dm" is supported'],
  [{ consentedAt: CONSENTED }, '"delivery" is null, and only "dm" is supported'],
  [true, 'the "alerts" setting is true, not the record `tools/alerts.js --consent --yes` writes']
];
CASES.forEach(function (c) {
  put(c[0]);
  assert.strictEqual(A.consentProblem(JSON.parse(fs.readFileSync(cfgPath, 'utf8'))), c[1], JSON.stringify(c[0]));
  assert.strictEqual(status(), 'Alerts are off: the "alerts" setting in your config cannot be used — ' + c[1] + '.', 'status: ' + JSON.stringify(c[0]));
  assert.strictEqual(which(), 'OFF — alerts are off: the "alerts" setting in your config cannot be used — ' + c[1] + '; this task has nothing to do until it is fixed', 'which: ' + JSON.stringify(c[0]));
  assert.ok(!/\bon\b/i.test(status()), 'it never says alerts are on: ' + status());
  assert.strictEqual(A.consent(JSON.parse(fs.readFileSync(cfgPath, 'utf8'))), null, 'and consent stays off');
});

// Off, declined and unset are not problems: their messages are what they were.
put(undefined);
assert.strictEqual(status(), 'Alerts off.'); assert.strictEqual(A.consentProblem({ you: 'a@b.co' }), null);
assert.strictEqual(which(), 'OFF — alerts are off, so this task has nothing to do');
put({ delivery: 'off', offeredAt: '2026-09-29T20:00:00Z' });
assert.strictEqual(status(), 'Alerts off (offered 2026-09-29, declined).'); assert.strictEqual(which(), 'OFF — alerts are off, so this task has nothing to do');
put({ delivery: 'off', offeredAt: '2026-09-29T20:00:00Z', offAt: '2026-09-30T09:00:00Z' });
assert.strictEqual(status(), 'Alerts off (turned off 2026-09-30).');
put(false);
assert.strictEqual(status(), 'Alerts off.');
// A valid record is on, with its times, and a missing "times" is the default pair.
put(good(['09:30', '12:00', '15:00']));
assert.ok(/^Alerts on at 09:30, 12:00, 15:00 \(since 2026-09-29\)\./.test(status()));
assert.ok(A.consent({ alerts: { delivery: 'dm', consentedAt: CONSENTED } }) && A.consentProblem({ alerts: { delivery: 'dm', consentedAt: CONSENTED } }) === null);
assert.deepStrictEqual(A.consent({ alerts: { delivery: 'dm', consentedAt: CONSENTED } }).times, ['12:00', '15:00']);
assert.ok(!/cannot be used/.test(which()), 'a valid record is not reported as a problem');

console.log('alerts problems: OK');
