/* A damaged state file is kept before anything replaces it (adversarial review 2026-10-05, ledger pass B5).
 *
 * status.json has always been copied aside when it cannot be read. The checks' own file (alerts.json), the two baseline files and the report queue were not: their code reads a
 * file it cannot parse as empty, and the next write replaced it, so the day's alert record, or the unsent reports, were gone with no copy. They are now copied, whole, to
 * `<file>.damaged-<stamp>-<random>` at the moment a write would replace them. A file that is absent, empty, or valid is not judged, and nothing else changes.
 * Everything runs in temporary directories.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var A = require('../src/alerts.js');
var outbox = require('../src/outbox.js');
var { preserveDamaged, writeAtomic } = require('../src/busy.js');

var fresh = function () { return fs.mkdtempSync(path.join(os.tmpdir(), 'ol-damaged-')); };
var copies = function (dir, base) { return fs.readdirSync(dir).filter(function (n) { return n.indexOf(base + '.damaged-') === 0; }); };
var TORN = '{"baselineVersion":"v1","alerted":{"k":3},"slots":{"2026-09-01":["12:00"]},"identitySalt":"abc';

/* ------------------------------ alerts.json (the checks' record) ------------------------------ */
var d = fresh();
fs.writeFileSync(path.join(d, 'alerts.json'), TORN);
A.checkSalt(d);                                    // the review's repro: makes a salt and writes the file
var kept = copies(d, 'alerts.json');
assert.strictEqual(kept.length, 1, 'the damaged alerts.json was kept');
assert.strictEqual(fs.readFileSync(path.join(d, kept[0]), 'utf8'), TORN, 'whole, byte for byte');
assert.ok(/^alerts\.json\.damaged-\d{8}T\d{4}-[0-9a-f]{8}$/.test(kept[0]), 'under the same kind of name status.json uses: ' + kept[0]);
assert.ok(JSON.parse(fs.readFileSync(path.join(d, 'alerts.json'), 'utf8')).identitySalt, 'and the file that replaced it is valid');
A.checkSalt(d);
assert.strictEqual(copies(d, 'alerts.json').length, 1, 'a valid file is not copied again');

// The baseline files.
var b = fresh();
fs.writeFileSync(path.join(b, 'alerts-baseline.json'), '{"date":"2026-09-30","items":{');
fs.writeFileSync(path.join(b, 'alerts-baseline.next.json'), 'not json at all');
A.stageBaseline(b, [], '2026-10-05', 'abcd');
assert.strictEqual(fs.readFileSync(path.join(b, copies(b, 'alerts-baseline.next.json')[0]), 'utf8'), 'not json at all', 'a damaged staged baseline is kept when staging replaces it');
assert.ok(A.promoteBaseline(b, 'abcd'), 'the staged baseline promotes');
assert.strictEqual(fs.readFileSync(path.join(b, copies(b, 'alerts-baseline.json')[0]), 'utf8'), '{"date":"2026-09-30","items":{', 'a damaged baseline is kept when the promotion replaces it');
assert.ok(JSON.parse(fs.readFileSync(path.join(b, 'alerts-baseline.json'), 'utf8')).version, 'which is valid now');

// Two separate damages are two separate copies.
fs.writeFileSync(path.join(d, 'alerts.json'), '{"torn":');
A.checkSalt(d);
assert.strictEqual(copies(d, 'alerts.json').length, 2, 'a second damage does not overwrite the first copy');

/* ------------------------------ the report queue ------------------------------ */
var q = fresh();
var entry = function (id) { return { report: { id: id }, queuedAt: new Date().toISOString(), tries: 0 }; };
fs.writeFileSync(outbox.files(q).outbox, '[{"report":{"id":"a"},"queuedAt":');
outbox.write(q, [entry('new')]);
var qk = copies(q, 'reports-outbox.json');
assert.strictEqual(qk.length, 1, 'a damaged queue is kept when a write replaces it');
assert.strictEqual(fs.readFileSync(path.join(q, qk[0]), 'utf8'), '[{"report":{"id":"a"},"queuedAt":', 'whole');
assert.strictEqual(outbox.read(q).length, 1, 'and the queue that replaced it is valid');
assert.ok(/the report queue could not be read; kept as reports-outbox\.json\.damaged-/.test(fs.readFileSync(outbox.files(q).log, 'utf8')), 'the log says so');
// Emptying a damaged queue deletes the file, so it is kept first.
var e = fresh();
fs.writeFileSync(outbox.files(e).outbox, 'garbage');
outbox.write(e, []);
assert.ok(!fs.existsSync(outbox.files(e).outbox), 'an emptied queue is removed as before');
assert.strictEqual(fs.readFileSync(path.join(e, copies(e, 'reports-outbox.json')[0]), 'utf8'), 'garbage', 'but a damaged one was kept first');
// A queue that is JSON of the wrong kind is damaged too.
var w = fresh();
fs.writeFileSync(outbox.files(w).outbox, '{"not":"a list"}');
outbox.write(w, [entry('x')]);
assert.strictEqual(copies(w, 'reports-outbox.json').length, 1, 'an object where a list belongs');

/* ------------------------------ what is not damage ------------------------------ */
var n = fresh();
outbox.write(n, [entry('ok')]);
outbox.write(n, [entry('ok'), entry('two')]);
assert.strictEqual(copies(n, 'reports-outbox.json').length, 0, 'a valid queue is not copied');
fs.writeFileSync(path.join(n, 'x.json'), '');
assert.strictEqual(preserveDamaged(path.join(n, 'x.json'), 'object'), null, 'an empty file is not judged');
assert.strictEqual(preserveDamaged(path.join(n, 'absent.json'), 'object'), null, 'nor is one that is not there');
fs.writeFileSync(path.join(n, 'bom.json'), '﻿[1,2]');
assert.strictEqual(preserveDamaged(path.join(n, 'bom.json'), 'array'), null, 'an editor\'s byte-order mark is not damage');
fs.writeFileSync(path.join(n, 'null.json'), 'null');
assert.ok(preserveDamaged(path.join(n, 'null.json'), 'object'), 'but "null" is not a record');
// writeAtomic only looks when asked to.
fs.writeFileSync(path.join(n, 'plain.json'), 'garbage');
assert.strictEqual(writeAtomic(path.join(n, 'plain.json'), '{}'), null);
assert.strictEqual(copies(n, 'plain.json').length, 0, 'a caller that did not ask is unchanged');

[d, b, q, e, w, n].forEach(function (x) { fs.rmSync(x, { recursive: true, force: true }); });
console.log('preserve damaged: OK');
