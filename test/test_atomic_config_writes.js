/* Files the user's setup lives in are written whole or not at all (adversarial review 2026-10-05, tooling E4/E5): the config rewritten by
 * `report.js --consent --yes` and `alerts.js --consent`, and the report queue. A plain writeFileSync truncates the file first, so a run
 * killed or failing midway left the config half written, and the next run could not read it. The crash is simulated: the write puts down
 * the first few bytes and then fails.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var report = require('../tools/report.js');
var alerts = require('../tools/alerts.js');
var outbox = require('../src/outbox.js');

var d = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-atomic-'));
var cfg = path.join(d, 'openloops.config.json');
var original = JSON.stringify({ you: 'alex@example.com', ledger: path.join(d, 'ledger.json'), channels: { include: ['#ops'] } }, null, 2) + '\n';
var reset = function () { fs.writeFileSync(cfg, original); };
var leftovers = function () { return fs.readdirSync(d).filter(function (n) { return /\.tmp$/.test(n); }); };

var realWrite = fs.writeFileSync;
var crash = function (fn) {
  fs.writeFileSync = function (f, data) { realWrite(f, String(data).slice(0, 12)); throw new Error('the process died mid-write'); };
  try { return fn(); } finally { fs.writeFileSync = realWrite; }
};

// Consent for diagnostics.
reset();
assert.throws(function () { crash(function () { report.consent(cfg, 'codex'); }); }, /died mid-write/);
assert.strictEqual(fs.readFileSync(cfg, 'utf8'), original, 'a failed diagnostics consent leaves the config whole');
assert.deepStrictEqual(leftovers(), [], 'and no temporary file behind');
report.consent(cfg, 'codex');
assert.ok(JSON.parse(fs.readFileSync(cfg, 'utf8')).diagnostics.install, 'a working one still records consent');

// Consent for midday alerts.
reset();
assert.throws(function () { crash(function () { alerts.main(['--consent', '--yes', '--config', cfg]); }); }, /died mid-write/);
assert.strictEqual(fs.readFileSync(cfg, 'utf8'), original, 'a failed alerts consent leaves the config whole');
assert.deepStrictEqual(leftovers(), [], 'and no temporary file behind');
alerts.main(['--consent', '--yes', '--config', cfg]);
assert.strictEqual(JSON.parse(fs.readFileSync(cfg, 'utf8')).alerts.delivery, 'dm', 'a working one still records consent');

// The report queue.
var entry = function (id) { return { report: { id: id }, queuedAt: new Date().toISOString(), tries: 0 }; };
outbox.write(d, [entry('a')]);
var queued = fs.readFileSync(outbox.files(d).outbox, 'utf8');
assert.throws(function () { crash(function () { outbox.write(d, [entry('a'), entry('b')]); }); }, /died mid-write/);
assert.strictEqual(fs.readFileSync(outbox.files(d).outbox, 'utf8'), queued, 'a failed queue write leaves the queue whole, not truncated');
assert.deepStrictEqual(leftovers(), [], 'and no temporary file behind');
outbox.write(d, [entry('a'), entry('b')]);
assert.strictEqual(outbox.read(d).length, 2, 'a working write still queues');

fs.rmSync(d, { recursive: true, force: true });
console.log('atomic config writes: OK');
