var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var cli = require('../tools/status.js');
var report = require('../tools/report.js');

var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-read-only-'));
var config = path.join(dir, 'config.json');
fs.writeFileSync(config, JSON.stringify({ you: 'alex@example.com', channels: { include: ['#ops'] } }));
var run = function (args) { return cli.main(args.concat(['--config', config])); };
var snapshot = function () {
  return fs.readdirSync(dir).sort().map(function (f) {
    return [f, fs.readFileSync(path.join(dir, f), 'utf8'), fs.statSync(path.join(dir, f)).mtimeMs];
  });
};

run(['--schedule', 'task-1', '0 18 * * 1-5']);
var before = snapshot();
assert.ok(/paused/.test(run(['--show', '--read-only', '--paused'])));
assert.deepStrictEqual(snapshot(), before, 'read-only scheduler facts never change schedule state');
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'status.json'))).schedule.state, 'active');

// Both parseable damage and a truncated file must remain byte-for-byte untouched.
[
  JSON.stringify({ schedule: { taskId: 'task-1', cron: '0 18 * * *', since: '2026-09-30', off: [null] } }),
  '{"schedule":{"taskId":"task-1","cron":"0 18 * * *","since":"2026-09-30"},"attempt":'
].forEach(function (raw) {
  fs.writeFileSync(path.join(dir, 'status.json'), raw);
  var unchanged = snapshot();
  var out = run(['--show', '--read-only']);
  assert.ok(out.indexOf('Status record is damaged. Read-only mode left it unchanged; displayed history includes only validated records.') > -1, out);
  assert.deepStrictEqual(snapshot(), unchanged, 'read-only view neither repairs nor archives damage');
});

before = snapshot();
assert.throws(function () { run(['--begin', '--read-only']); }, /read-only/);
assert.deepStrictEqual(snapshot(), before, 'read-only cannot be combined with a write command');

var consent = report.consentText().replace(/\s+/g, ' ');
assert.ok(consent.indexOf('random installation and report IDs') > -1);
assert.ok(consent.indexOf('whether Claude or Codex ran it') > -1);
assert.ok(consent.indexOf('a generic error class such as TypeError (never its message)') > -1);
assert.ok(consent.indexOf('spot-check sample and miss counts') > -1);
console.log('Codex status and diagnostic disclosure: OK');
