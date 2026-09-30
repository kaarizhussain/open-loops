/* The status record must never cost a digest, and must never be silently erased.
 *
 * Damaged: a record that is unreadable, truncated, or whole JSON with entries that fail their checks. It is preserved
 * whole under a unique name before anything replaces it; only records that parse on their own AND validate are
 * recovered; a truncated record is never completed by guessing. Bad arguments (an impossible date, a delivery without
 * a valid reference) are refused with nothing recorded.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');
var S = require('../src/status.js');
var cli = require('../tools/status.js');
var { main } = require('../slack-run.js');

var tmp = function () { return fs.mkdtempSync(path.join(os.tmpdir(), 'ol-harden-')); };
var at = function (s) { return S.parseNow(s); };
var statusFile = function (d) { return path.join(d, 'status.json'); };
var put = function (d, o) { fs.writeFileSync(statusFile(d), typeof o === 'string' ? o : JSON.stringify(o)); };
var bytes = function (d) { return fs.existsSync(statusFile(d)) ? fs.readFileSync(statusFile(d), 'utf8') : null; };
var preserved = function (d) { return fs.readdirSync(d).filter(function (f) { return /^status\.json\.damaged-/.test(f); }); };
var GOOD_S = { taskId: 't', cron: '0 18 * * *', since: '2026-08-01', state: 'active', off: [] };
var GOOD_D = { date: '2026-09-01', at: '2026-09-01T22:00:00.000Z', ref: 'aaaa', read: { state: 'complete', why: [] }, channels: ['#ops'],
  conversations: 1, messages: 3, meetings: 0, windowDays: 21 };
var GOOD_A = { id: '0123abcd', date: '2026-09-01', startedAt: '2026-09-01T22:00:00.000Z', outcome: 'delivered', ref: 'aaaa', notice: 'none' };

/* ------------------------------ 1. a hand-damaged record cannot crash anything ------------------------------ */
var shapes = {
  'null in off': { schedule: Object.assign({}, GOOD_S, { off: [null] }), delivered: GOOD_D },
  'junk in off': { schedule: Object.assign({}, GOOD_S, { off: [5, 'x', {}, { from: 'banana', to: null }] }), delivered: GOOD_D },
  'off is a string': { schedule: Object.assign({}, GOOD_S, { off: 'x' }), delivered: GOOD_D },
  'schedule is a string': { schedule: 'x', delivered: GOOD_D },
  'schedule has no cron': { schedule: { taskId: 't', since: '2026-08-01' }, delivered: GOOD_D },
  'schedule state is junk': { schedule: Object.assign({}, GOOD_S, { state: 'asleep' }), delivered: GOOD_D },
  'delivered date is junk': { schedule: GOOD_S, delivered: Object.assign({}, GOOD_D, { date: 'banana' }) },
  'delivered ref is junk': { schedule: GOOD_S, delivered: Object.assign({}, GOOD_D, { ref: 'zzzz' }) },
  'attempt is junk': { schedule: GOOD_S, delivered: GOOD_D, attempt: { id: 1, outcome: 'maybe' } },
  'the root is an array': [1, 2], 'the root is null': null, 'the root is a number': 5, 'empty file': '', 'not json': 'not json at all'
};
Object.keys(shapes).forEach(function (name) {
  var d = tmp(); put(d, shapes[name] === null ? 'null' : shapes[name]);
  assert.doesNotThrow(function () { S.load(d); S.gap(d, '2026-09-30'); S.view(d, {}, null, at('2026-09-30T12:00'), {}); }, name);
  assert.ok(S.load(d).damaged, name + ' is reported as damaged');
});
// And the digest itself does not die of it. This crashed the runner: `off: [null]` threw inside the gap line.
(function () {
  var d = tmp(), c = path.join(d, 'openloops.config.json'), p = path.join(d, 'i.json');
  fs.writeFileSync(c, JSON.stringify({ you: 'alex@example.com', selfDm: 'U0EXAMPLE001', tzOffset: 0, spotCheck: 0, ledger: path.join(d, 'l.json'), channels: { include: ['#vector-freight'] } }));
  put(d, { schedule: Object.assign({}, GOOD_S, { off: [null] }), delivered: GOOD_D });
  fs.writeFileSync(p, JSON.stringify({ today: '2026-09-30', conversations: [{ channel: '#vector-freight', members: [], text: '', complete: true }], dm: { channel: 'D0', text: '' } }));
  var out = main([p, '--config', c, '--dry']);
  assert.ok(/^OPEN LOOPS — for 2026-09-30/.test(out), 'the digest is produced');
  assert.ok(/Previous digest: /.test(out), 'and the valid parts of the record still work: the gap line is there');
  var real = main([p, '--config', c]);   // a real run too: it only stages status, it never writes the record
  assert.ok(/^OPEN LOOPS — for 2026-09-30/.test(real));
  assert.ok(preserved(d).length === 0, 'the runner is not the status writer and preserves nothing');
})();

/* ------------------------------ 3. damage is preserved, and only what is whole and valid is recovered ------------------------------ */
// Truncated JSON, cut inside the last record: earlier complete records are recovered, the cut one is not completed.
var FULL = '{"schedule": ' + JSON.stringify(GOOD_S) + ', "attempt": ' + JSON.stringify(GOOD_A) + ', "delivered": ' + JSON.stringify(GOOD_D) + '}';
var cut = FULL.slice(0, FULL.indexOf('"delivered": ') + 40);
var t1 = tmp(); put(t1, cut);
var l1 = S.load(t1);
assert.deepStrictEqual(l1.schedule, { taskId: 't', cron: '0 18 * * *', since: '2026-08-01', state: 'active', off: [] }, 'the complete schedule before the cut is recovered');
assert.strictEqual(l1.attempt && l1.attempt.id, '0123abcd', 'and the complete attempt');
assert.strictEqual(l1.delivered, null, 'the delivered record was cut off, and is not reconstructed from the fragment');
assert.deepStrictEqual(l1.damaged.recovered, ['schedule', 'last attempt']);
assert.deepStrictEqual(l1.damaged.lost, ['last delivered digest']);
assert.strictEqual(bytes(t1), cut, 'reading changes nothing');
// Cut one character short of a whole record: it is not closed, so it is not a record. Closing it would be a guess.
var tg = tmp(); put(tg, FULL.slice(0, FULL.length - 2));
assert.strictEqual(S.load(tg).delivered, null, 'a delivered record missing only its closing brace is not completed for the reader');
assert.strictEqual(S.load(tg).schedule.taskId, 't');
// Cut inside the FIRST record: nothing after it can be trusted to be reached, and nothing is invented.
var t2 = tmp(); put(t2, FULL.slice(0, 60));
assert.deepStrictEqual([S.load(t2).schedule, S.load(t2).attempt, S.load(t2).delivered], [null, null, null]);
assert.deepStrictEqual(S.load(t2).damaged.recovered, []);
// A fragment that happens to close early is still not a record unless it validates.
var t3 = tmp(); put(t3, '{"delivered": {"date": "2026-09-01"}, "schedule": ' + JSON.stringify(GOOD_S) + ', "attempt": {"id":');
assert.strictEqual(S.load(t3).delivered, null, 'a record missing its fields is not recovered');
assert.strictEqual(S.load(t3).schedule.taskId, 't');

// Malformed but valid JSON: the bad entries are dropped, the rest kept, and the file is still treated as damaged.
var m1 = tmp(); put(m1, { schedule: Object.assign({}, GOOD_S, { off: [null, { from: '2026-09-01', to: null }, { from: '2026-02-31', to: null }] }), delivered: Object.assign({}, GOOD_D, { ref: 'zzzz' }) });
var lm = S.load(m1);
assert.deepStrictEqual(lm.schedule.off, [{ from: '2026-09-01', to: null }], 'only the valid pause stretch survives');
assert.strictEqual(lm.delivered, null, 'a delivery with an invalid reference is not recovered');
assert.ok(lm.damaged && lm.damaged.lost.indexOf('last delivered digest') > -1);

// Preservation: the original bytes are kept under a unique name, and the record is rewritten from what was recovered.
var p1 = tmp(); put(p1, cut);
var before = bytes(p1);
var repaired = S.repair(p1, at('2026-10-01T16:42'));
var kept = preserved(p1);
assert.strictEqual(kept.length, 1, 'the damaged file was preserved');
assert.ok(/^status\.json\.damaged-20261001T1642-[0-9a-f]{8}$/.test(kept[0]), kept[0]);
assert.strictEqual(fs.readFileSync(path.join(p1, kept[0]), 'utf8'), before, 'byte for byte');
assert.doesNotThrow(function () { JSON.parse(bytes(p1)); }, 'and the record is whole again');
assert.ok(!repaired.damaged && repaired.schedule && repaired.attempt && !repaired.delivered);
assert.ok(repaired.note && repaired.note.file === kept[0] && repaired.note.recovered.join() === 'schedule,last attempt');
// Damaged again, the same minute: a second, different file. The first is never overwritten.
put(p1, 'torn again');
S.repair(p1, at('2026-10-01T16:42'));
var kept2 = preserved(p1);
assert.strictEqual(kept2.length, 2, 'two damaged files, two preserved copies');
assert.strictEqual(fs.readFileSync(path.join(p1, kept[0]), 'utf8'), before, 'the first copy is untouched');
assert.strictEqual(fs.readFileSync(path.join(p1, kept2.filter(function (f) { return f !== kept[0]; })[0]), 'utf8'), 'torn again');
// A record that is fine is not touched, and a missing one is not damage.
var ok = tmp(); put(ok, { schedule: GOOD_S, attempt: GOOD_A, delivered: GOOD_D });
S.repair(ok, at('2026-10-01T16:42')); assert.strictEqual(preserved(ok).length, 0, 'an intact record is left alone');
var missing = tmp(); S.repair(missing, at('2026-10-01T16:42'));
assert.ok(!fs.existsSync(statusFile(missing)) && S.load(missing).damaged === null, 'no file is not damage, and nothing is created');

// Any write to a damaged record preserves it first — the bug was that begin() replaced it with an empty one.
var w = tmp(); put(w, cut);
S.begin(w, '2026-10-01', at('2026-10-01T18:03'));
assert.strictEqual(preserved(w).length, 1, 'begin on a damaged record preserves it');
assert.strictEqual(S.load(w).schedule.taskId, 't', 'and the schedule survives it (it used to be erased)');
assert.strictEqual(S.load(w).attempt.outcome, 'started');

// The status says so, in the approved words.
var pv = tmp(); put(pv, cut); S.repair(pv, at('2026-10-01T16:42'));
var vs = S.view(pv, {}, null, at('2026-10-02T10:00'), {});
assert.ok(/Status record {11}damaged: kept as status\.json\.damaged-20261001T1642-[0-9a-f]{8}\.\n {24}Recovered: /.test(vs), vs);
var vNothing = tmp(); put(vNothing, 'garbage'); S.repair(vNothing, at('2026-10-01T16:42'));
assert.ok(/Recovered: nothing\./.test(S.view(vNothing, {}, null, at('2026-10-02T10:00'), {})));
assert.ok(/Recovered: schedule, last attempt\. Not recovered: last delivered digest\./.test(vs), vs);
// A delivered digest clears the note: the record is whole and current again.
var vClear = tmp(); put(vClear, cut); S.repair(vClear, at('2026-10-01T16:42'));
var cid = S.begin(vClear, '2026-10-01'); S.end(vClear, { id: cid, brief: 'posted', details: 'posted', verified: true, ref: 'bbbb' });
assert.ok(!/Status record/.test(S.view(vClear, {}, null, at('2026-10-02T10:00'), {})));
// Through the command line: --show repairs, and says so.
var cd = tmp(), cc = path.join(cd, 'c.json'); fs.writeFileSync(cc, '{}'); put(cd, cut);
var shown = cli.main(['--show', '--config', cc, '--now', '2026-10-01T16:42']);
assert.ok(/Status record {11}damaged: kept as status\.json\.damaged-/.test(shown) && preserved(cd).length === 1, shown);

/* ------------------------------ 4. dates are real dates, and a bad one records nothing ------------------------------ */
['2026-02-31', '2026-13-01', '2026-00-10', '2026-9-30', '26-09-30', 'banana', '', '2026-02-29', '2026-09-31', '2026-09-30T18:00'].forEach(function (bad) {
  assert.strictEqual(S.validDate(bad), false, bad + ' is not a real date');
});
['2026-09-30', '2028-02-29', '2026-12-31', '2026-01-01'].forEach(function (good) { assert.strictEqual(S.validDate(good), true, good); });
var bd = tmp(); put(bd, { schedule: GOOD_S, delivered: GOOD_D });
var beforeBd = bytes(bd);
['2026-02-31', 'banana', '2026-9-30'].forEach(function (bad) {
  assert.throws(function () { S.begin(bd, bad, at('2026-10-01T18:03')); }, /--today must be a real date/, bad);
  assert.strictEqual(bytes(bd), beforeBd, 'a refused --today leaves the record as it was');
});
var bd2 = tmp(), bc = path.join(bd2, 'c.json'); fs.writeFileSync(bc, '{}');
assert.throws(function () { cli.main(['--begin', '--today', '2026-02-31', '--config', bc]); }, /--today must be a real date like 2026-09-30, got "2026-02-31"\. Nothing was recorded\./);
assert.ok(!fs.existsSync(statusFile(bd2)), 'and on the command line, nothing is created');
// A refused date on a damaged record does not preserve or rewrite it either.
var bd3 = tmp(); put(bd3, cut);
assert.throws(function () { S.begin(bd3, '2026-02-31', at('2026-10-01T18:03')); }, /real date/);
assert.strictEqual(bytes(bd3), cut); assert.strictEqual(preserved(bd3).length, 0, 'invalid arguments change nothing at all');

/* ------------------------------ 5. a delivery needs a valid reference ------------------------------ */
var rd = tmp(); var rid = S.begin(rd, '2026-10-01', at('2026-10-01T18:03'));
var beforeRd = bytes(rd);
var deliver = function (ref) { return function () { S.end(rd, { id: rid, brief: 'posted', details: 'posted', verified: true, ref: ref }, at('2026-10-01T18:05')); }; };
assert.throws(deliver(undefined), /A delivered digest needs --ref, the four-character reference in its header\. Nothing was recorded\./, 'no reference');
assert.throws(deliver(''), /needs --ref/);
['null', 'ABCD', 'abc', 'abcde', 'zzzz', '12 4'].forEach(function (bad) { assert.throws(deliver(bad), /--ref must be the four-character reference/, bad); });
assert.strictEqual(bytes(rd), beforeRd, 'every refused delivery leaves the attempt open and the record unchanged');
assert.strictEqual(S.load(rd).attempt.outcome, 'started'); assert.strictEqual(S.load(rd).delivered, null);
// A malformed reference is refused for a partial outcome too: nothing records a value the DM reader would not accept.
assert.throws(function () { S.end(rd, { id: rid, brief: 'posted', details: 'rejected', verified: true, ref: 'nope' }, at('2026-10-01T18:05')); }, /--ref must be/);
assert.strictEqual(bytes(rd), beforeRd);
// An outcome that is not a delivery needs none.
var nd = tmp(); var nid = S.begin(nd, '2026-10-01');
assert.strictEqual(S.end(nd, { id: nid, brief: 'rejected', details: 'not_attempted', verified: false, failed: 'post' }).outcome, 'not_delivered');
// And a valid one delivers, with the read facts staged for that digest.
S.stage(rd, { ref: 'c0de', date: '2026-10-01', read: { state: 'complete', why: [] }, channels: ['#ops'], conversations: 1, messages: 2, meetings: 0, windowDays: 21 });
assert.strictEqual(S.end(rd, { id: rid, brief: 'posted', details: 'posted', verified: true, ref: 'c0de' }, at('2026-10-01T18:05')).outcome, 'delivered');
assert.strictEqual(S.load(rd).delivered.ref, 'c0de'); assert.strictEqual(S.load(rd).delivered.read.state, 'complete');
assert.ok(!/ref null/.test(S.view(rd, {}, null, at('2026-10-02T10:00'), {})), 'the status never prints "ref null"');
// Command line.
var cr = tmp(), ccr = path.join(cr, 'c.json'); fs.writeFileSync(ccr, '{}');
var crid = cli.main(['--begin', '--today', '2026-10-01', '--config', ccr]).split('\n')[0].replace('ATTEMPT ', '');
var beforeCr = bytes(cr);
assert.throws(function () { cli.main(['--end', '--attempt', crid, '--brief', 'posted', '--details', 'posted', '--verified', 'yes', '--config', ccr]); }, /needs --ref/);
assert.strictEqual(bytes(cr), beforeCr, 'and the command line records nothing either');

console.log('status hardening: OK');
