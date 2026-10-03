/* A preview is not a run (codex-debug-review, 2026-10-02, findings 4 and 5).
 *
 * The Codex procedure said to send reports after every run, previews included, and the runner itself pruned the outbox and
 * queued a crash report under --dry: a preview against a consented setup changed, or sent, real diagnostics. A preview now
 * leaves the outbox exactly as it found it, and the procedure says to skip reporting.
 *
 * The same procedure named report stages by the status names (fetch, build, verify), which report.js rejects. It now
 * translates every status stage to one report.js accepts.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var { main, queueCrash } = require('../slack-run.js');
var report = require('../tools/report.js');
var outbox = require('../src/outbox.js');
var D = require('../src/diagnostics.js');

var NL = String.fromCharCode(10);
var d = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-preview-')), cfgPath = path.join(d, 'openloops.config.json');
fs.writeFileSync(cfgPath, JSON.stringify({ you: 'alex@example.com', tzOffset: 0, spotCheck: 0, ledger: path.join(d, 'l.json') }));
report.consent(cfgPath, 'codex');
var files = outbox.files(d);

/* ------------------------------ a preview leaves the outbox alone ------------------------------ */
// An entry from an earlier consent: any prune discards it and logs that it did.
var stale = JSON.stringify([{ report: { install: 'earlier-consent', id: 'x' }, queuedAt: new Date().toISOString(), tries: 0 }], null, 2) + NL;
fs.writeFileSync(files.outbox, stale);
var input = path.join(d, 'i.json');
fs.writeFileSync(input, JSON.stringify({ today: '2026-10-02', conversations: [{ channel: '#ops', members: [],
  text: '=== Message from Lena <lena@example.com> (U0EXAMPLE002) at now ===' + NL + 'Message TS: 1790870400.000001' + NL + 'Thanks.', complete: true }] }));
main([input, '--config', cfgPath, '--dry']);
assert.ok(fs.existsSync(files.outbox) && fs.readFileSync(files.outbox, 'utf8') === stale, 'a preview does not prune the outbox');
assert.ok(!fs.existsSync(files.log), 'nor write the report log');

// A preview that fails queues no crash report.
fs.unlinkSync(files.outbox);
queueCrash([input, '--config', cfgPath, '--dry'], new Error('boom'));
assert.ok(!fs.existsSync(files.outbox), 'a failed preview queues nothing');
// A real run that fails still does: the gate is the preview, not the reporting.
queueCrash([input, '--config', cfgPath], new Error('boom'));
assert.strictEqual(outbox.read(d).length, 1, 'a failed real run is still reported');

/* ------------------------------ the Codex procedure's stage names are ones report.js takes ------------------------------ */
var codex = fs.readFileSync(path.join(__dirname, '../skills/open-loops/references/codex.md'), 'utf8').replace(/\s+/g, ' ');
var step = codex.slice(codex.indexOf('End every authorized real run'), codex.indexOf('## Scheduling in Codex'));
assert.ok(/A preview \(`--dry`\) skips this step entirely/.test(step), 'the procedure says a preview does not report');
var mapped = {};
(step.match(/`[a-z_]+` → `[a-z_]+`(?: or `[a-z_]+`)?/g) || []).forEach(function (m) {
  var names = m.match(/`[a-z_]+`/g).map(function (x) { return x.slice(1, -1); });
  mapped[names[0]] = names.slice(1);
});
// Every stage status.js --end takes (SKILL.md, "End the attempt") is translated, and only to a stage report.js accepts.
['config', 'ledger', 'fetch', 'build', 'post', 'verify'].forEach(function (s) {
  assert.ok(mapped[s] && mapped[s].length, 'the procedure translates ' + s);
  mapped[s].forEach(function (t) { assert.ok(D.STAGES.indexOf(t) > -1, s + ' → ' + t + ' is a stage report.js takes'); });
});

fs.rmSync(d, { recursive: true, force: true });
console.log('preview diagnostics: OK');
