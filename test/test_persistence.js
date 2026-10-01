/* The last open items from the adversarial test run.
 *
 *  1. status.json that cannot be read or written: named as read / write / uncertain, reported as exit 5 rather than success, the notice still made from the
 *     run's own facts, and never offered twice.
 *  2. A missing or unrecognised failure stage is "unknown", not "the digest was built".
 *  3. Contradictory --end facts are refused.
 *  4. The runner's ledger messages no longer tell anyone to move the ledger aside; a same-day re-run cannot get round the lost-salt guard.
 *  5. restores.json: every request validated, an invalid one makes the file unusable (and untouched); one item asked for two ways is one request with a
 *     terminal result for each id; a damaged restore record in the ledger is exit 4.
 *  6. A temporary file is removed only by the write that made it. "v2" and "Q3" are not item numbers.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');
var cli = require('../tools/status.js');
var corr = require('../tools/corrections.js');
var S = require('../src/status.js');
var L = require('../src/ledger.js');
var R = require('../src/restore.js');
var { fileStore } = require('../src/store.js');
var { main } = require('../slack-run.js');

var ROOT = path.join(__dirname, '..'), NL = String.fromCharCode(10), ME = 'alex@example.com';
var tmp = function () { return fs.mkdtempSync(path.join(os.tmpdir(), 'ol-persist-')); };
var ts = function (mo, d, h, mi) { return (Date.UTC(2026, mo - 1, d, h, mi || 0) / 1000).toFixed(6); };

/* ---- break the filesystem, on purpose, for one call */
var failing = function (what, code, fn) {
  var realW = fs.writeFileSync, realR = fs.renameSync;
  // The write fails after it has begun: the operation's own temporary file exists, half-written, and has to be cleaned up by it.
  if (what === 'write') fs.writeFileSync = function (f) { if (/\.tmp$/.test(String(f))) { realW.call(fs, f, 'partial'); var e = new Error(code + ': simulated'); e.code = code; throw e; } return realW.apply(fs, arguments); };
  if (what === 'rename') fs.renameSync = function (a, b) { if (/\.tmp$/.test(String(a))) { var e = new Error(code + ': simulated'); e.code = code; throw e; } return realR.apply(fs, arguments); };
  try { return fn(); } finally { fs.writeFileSync = realW; fs.renameSync = realR; }
};
var caught = function (fn) { try { fn(); } catch (e) { return e; } assert.fail('expected a failure'); };
var tmps = function (d) { return fs.readdirSync(d).filter(function (f) { return /\.tmp$/.test(f); }); };

/* ============================== 1. status.json that cannot be read or written ============================== */
var cfgOf = function (d) { return path.join(d, 'c.json'); };
var FAIL = ['--brief', 'not_attempted', '--details', 'not_attempted', '--verified', 'no', '--failed', 'build'];
var begin = function (d) { return cli.main(['--begin', '--today', '2026-10-01', '--now', '2026-10-01T18:00', '--config', cfgOf(d)]).match(/ATTEMPT ([0-9a-f]+)/)[1]; };
var endArgs = function (d, id, flags) { return ['--end', '--attempt', id, '--config', cfgOf(d)].concat(flags || FAIL); };
var READ = 'status: could not read status.json (EISDIR). It was not changed.';
var WRITE = function (c) { return 'status: could not write status.json (' + c + '). It was not changed.'; };
var UNSURE = function (c) { return 'status: status.json may or may not have been updated (' + c + '): the new version was written but could not be moved into place. Check with: node tools/status.js --show --read-only'; };
var CONTINUE = 'The run can continue without an attempt record. End it with: node tools/status.js --end --attempt UNRECORDED --today <date> …: a failure notice is still generated from what the run did.';

// --begin: three ways it can fail, each named, each exit 5, each still printing what the run needs to carry on.
var d1 = tmp(); fs.mkdirSync(path.join(d1, 'status.json'));
var e1 = caught(function () { cli.main(['--begin', '--today', '2026-10-01', '--now', '2026-10-01T18:00', '--config', cfgOf(d1)]); });
assert.strictEqual(e1.exitCode, 5, 'a read failure is not an ordinary result');
assert.ok(/^ATTEMPT UNRECORDED\nSTARTED \d+$/.test(e1.stdout), 'the run still gets what it needs: ' + e1.stdout);
assert.strictEqual(e1.message, READ + NL + CONTINUE);
var d2 = tmp(); fs.writeFileSync(path.join(d2, 'status.json.1.aaaaaa.tmp'), 'another operation');
var e2 = failing('write', 'EACCES', function () { return caught(function () { cli.main(['--begin', '--today', '2026-10-01', '--config', cfgOf(d2)]); }); });
assert.strictEqual(e2.exitCode, 5); assert.strictEqual(e2.message, WRITE('EACCES') + NL + CONTINUE);
assert.deepStrictEqual(tmps(d2), ['status.json.1.aaaaaa.tmp'], 'a failed write removes its own temporary file, and only that one');
var d3 = tmp(); fs.writeFileSync(path.join(d3, 'status.json.1.aaaaaa.tmp'), 'another operation');
var e3 = failing('rename', 'EPERM', function () { return caught(function () { cli.main(['--begin', '--today', '2026-10-01', '--config', cfgOf(d3)]); }); });
assert.strictEqual(e3.exitCode, 5); assert.strictEqual(e3.message, UNSURE('EPERM') + NL + CONTINUE);
assert.ok(!/Nothing was recorded/.test(e3.message), 'it does not claim nothing was recorded when that is not established');
assert.deepStrictEqual(tmps(d3), ['status.json.1.aaaaaa.tmp'], 'and so does a rename that failed');
// A missing folder is a write failure, named as one, and the process exits 5.
var gone = path.join(tmp(), 'no', 'such', 'folder', 'c.json');
var spawned = cp.spawnSync(process.execPath, [path.join(ROOT, 'tools', 'status.js'), '--begin', '--today', '2026-10-01', '--config', gone], { encoding: 'utf8' });
assert.strictEqual(spawned.status, 5, spawned.stderr);
assert.ok(/^ATTEMPT UNRECORDED\r?\nSTARTED \d+/.test(spawned.stdout) && /could not write status\.json \(ENOENT\)\. It was not changed\./.test(spawned.stderr), spawned.stdout + spawned.stderr);

// --end that cannot persist: the notice is still made, from the run's own facts, and it is the only one.
var ONCE = 'This notice is the only one for this attempt: post it once, and do not run --end again. Tell the user the attempt could not be recorded.';
var d4 = tmp(), id4 = begin(d4);
var e4 = failing('write', 'EACCES', function () { return caught(function () { cli.main(endArgs(d4, id4), function () {}); }); });
assert.strictEqual(e4.exitCode, 5);
assert.ok(/^OPEN LOOPS NOT RUN — for 2026-10-01/.test(e4.stdout), 'the notice is not lost: ' + e4.stdout);
assert.strictEqual(e4.message, WRITE('EACCES') + NL + ONCE);
assert.strictEqual(S.load(d4).attempt.outcome, 'started', 'a write that failed changed nothing');
var e4b = failing('rename', 'EBUSY', function () { return caught(function () { cli.main(endArgs(d4, id4), function () {}); }); });
assert.strictEqual(e4b.message, UNSURE('EBUSY') + NL + ONCE, 'an uncertain write is said to be uncertain');
// A delivery that cannot be saved is not hidden either.
var d5 = tmp(), id5 = begin(d5);
var e5 = failing('write', 'EACCES', function () { return caught(function () { cli.main(endArgs(d5, id5, ['--brief', 'posted', '--details', 'posted', '--verified', 'yes', '--ref', 'abcd']), function () {}); }); });
assert.strictEqual(e5.stdout, 'DELIVERED — NOT RECORDED.');
assert.strictEqual(e5.message, WRITE('EACCES') + NL + 'Tell the user the delivery could not be recorded.');
assert.strictEqual(S.load(d5).delivered, null);
// --end when the record cannot even be read: the notice is still made, with an honest last-delivered line.
var d6 = tmp(), id6 = begin(d6);
fs.unlinkSync(path.join(d6, 'status.json')); fs.mkdirSync(path.join(d6, 'status.json'));
var e6 = caught(function () { cli.main(endArgs(d6, id6).concat(['--today', '2026-10-01']), function () {}); });
assert.strictEqual(e6.exitCode, 5);
assert.ok(/^OPEN LOOPS NOT RUN — for 2026-10-01/.test(e6.stdout) && /Last delivered digest: not known — the status record could not be read\./.test(e6.stdout), e6.stdout);
assert.strictEqual(e6.message, READ + NL + 'record: NOT RECORDED — this attempt has no record, because --begin could not save one.' + NL + 'This notice is the only one for this attempt: post it once.');

// An attempt that began without a record: the notice is made from the facts of the run.
var d7 = tmp();
var u = caught(function () { cli.main(['--end', '--attempt', 'UNRECORDED', '--today', '2026-10-01', '--config', cfgOf(d7)].concat(FAIL), function () {}); });
assert.strictEqual(u.exitCode, 5);
assert.ok(/^OPEN LOOPS NOT RUN — for 2026-10-01\nSlack was fetched, but processing failed/.test(u.stdout), u.stdout);
assert.ok(/No verified delivery recorded by status tracking yet\./.test(u.stdout), 'a readable status with no delivery says so');
assert.ok(u.message.indexOf('record: NOT RECORDED — this attempt has no record, because --begin could not save one.') === 0);
assert.strictEqual(S.load(d7).attempt, null, 'and nothing was recorded for it');
var uc = caught(function () { cli.main(['--end', '--attempt', 'UNRECORDED', '--today', '2026-10-01', '--config', cfgOf(d7), '--brief', 'not_attempted', '--details', 'not_attempted', '--verified', 'no', '--failed', 'config', '--fetched', 'no'], function () {}); });
assert.ok(/Open Loops' configuration can't be used, so nothing was fetched/.test(uc.stdout), 'the stage facts still decide what the notice says');
var ud = caught(function () { cli.main(['--end', '--attempt', 'UNRECORDED', '--today', '2026-10-01', '--config', cfgOf(d7), '--brief', 'posted', '--details', 'posted', '--verified', 'yes', '--ref', 'abcd'], function () {}); });
assert.strictEqual(ud.stdout, 'DELIVERED — NOT RECORDED.');
assert.throws(function () { cli.main(['--end', '--attempt', 'UNRECORDED', '--config', cfgOf(d7)].concat(FAIL), function () {}); }, /--today must be a real date/, 'it needs the date: it has no record to take it from');
var un = caught(function () { cli.main(['--notice-result', 'posted', '--attempt', 'UNRECORDED', '--config', cfgOf(d7)]); });
assert.strictEqual(un.exitCode, 5);
assert.strictEqual(un.message, 'record: NOT RECORDED — this attempt has no record, because --begin could not save one.', 'there is nothing to record a notice result against');
// A last delivery that is known is still named.
var d8 = tmp(); fs.writeFileSync(path.join(d8, 'status.json'), JSON.stringify({ delivered: { date: '2026-09-30', at: '2026-09-30T22:00:00.000Z', ref: 'abcd' } }));
var u8 = caught(function () { cli.main(['--end', '--attempt', 'UNRECORDED', '--today', '2026-10-01', '--config', cfgOf(d8)].concat(FAIL), function () {}); });
assert.ok(/Last delivered digest: Wed 2026-09-30 · ref abcd/.test(u8.stdout), u8.stdout);
// Other commands report persistence failures the same way.
var d9 = tmp();
var e9 = failing('write', 'EACCES', function () { return caught(function () { cli.main(['--schedule', 't', '0 18 * * *', '--config', cfgOf(d9)]); }); });
assert.strictEqual(e9.exitCode, 5); assert.strictEqual(e9.message, WRITE('EACCES'));

/* ============================== 2. an unrecognised stage is unknown ============================== */
var unk = tmp();
fs.writeFileSync(path.join(unk, 'status.json'), JSON.stringify({ attempt: { id: '0123abcd', date: '2026-10-01', startedAt: '2026-10-01T10:00:00Z', endedAt: '2026-10-01T10:05:00Z', outcome: 'not_delivered', cause: 'weird', notice: 'pending' } }));
var vu = S.view(unk, {}, null, S.parseNow('2026-10-01T19:00'), {});
assert.ok(!/was built|posting failed/.test(vu), 'no claim that the digest was built: ' + vu);
assert.ok(/delivery unknown: Open Loops could not confirm whether the digest posted\./.test(vu), vu);
var nn = S.notice({ outcome: 'not_delivered', date: '2026-10-01', cause: null }, null);
assert.ok(/^OPEN LOOPS DELIVERY UNKNOWN — for 2026-10-01/.test(nn.text) && !/was built|run Open Loops" again|To try again now/.test(nn.text), nn.text);
assert.ok(/was built, but it could not be posted/.test(S.notice({ outcome: 'not_delivered', date: '2026-10-01', cause: 'post' }, null).text), 'a recorded post failure still says so');

/* ============================== 3. contradictory --end facts ============================== */
var cf = tmp(), idc = begin(cf);
var refused = function (flags, re) {
  assert.throws(function () { cli.main(endArgs(cf, idc, flags), function () {}); }, function (e) { return re.test(e.message); });
  assert.strictEqual(S.load(cf).attempt.outcome, 'started', 'a refusal records nothing');
};
refused(['--brief', 'rejected', '--details', 'not_attempted', '--verified', 'no', '--failed', 'fetch'], /^--failed fetch means the run stopped before posting, so --brief and --details must be not_attempted, got rejected\/not_attempted\. Nothing was recorded\.$/);
refused(['--brief', 'unknown', '--details', 'unknown', '--verified', 'no', '--failed', 'build'], /^--failed build means the run stopped before posting, so --brief and --details must be not_attempted, got unknown\/unknown\. Nothing was recorded\.$/);
refused(['--brief', 'not_attempted', '--details', 'posted', '--verified', 'no', '--failed', 'ledger'], /^--failed ledger means the run stopped before posting, so --brief and --details must be not_attempted, got not_attempted\/posted\./);
refused(['--brief', 'not_attempted', '--details', 'not_attempted', '--verified', 'no', '--failed', 'fetch', '--fetched', 'yes'], /^--fetched only goes with --failed config\. Nothing was recorded\.$/);
refused(['--brief', 'rejected', '--details', 'not_attempted', '--verified', 'no', '--failed', 'post', '--fetched', 'no'], /^--fetched only goes with --failed config\./);
assert.ok(/^OPEN LOOPS NOT RUN/.test(cli.main(endArgs(cf, idc, ['--brief', 'rejected', '--details', 'not_attempted', '--verified', 'no', '--failed', 'post']), function () {})), 'a post that was tried and refused is still fine');

/* ============================== 4. the runner's ledger messages ============================== */
var rdir = tmp(), rcfg = path.join(rdir, 'c.json'), rled = path.join(rdir, 'ledger.json'), rin = path.join(rdir, 'in.json');
fs.writeFileSync(rcfg, JSON.stringify({ you: ME, selfDm: 'U0EXAMPLE001', tzOffset: 0, spotCheck: 0, ledger: rled, channels: { include: ['#ops'] } }));
fs.writeFileSync(rin, JSON.stringify({ today: '2026-10-01', conversations: [{ channel: '#ops', members: [], text: '', complete: true }], dm: { channel: 'D0', text: '' } }));
var runner = function (args) { return cp.spawnSync(process.execPath, [path.join(ROOT, 'slack-run.js')].concat(args), { encoding: 'utf8', cwd: ROOT }); };
fs.writeFileSync(rled, '{ not a ledger');
var bad = runner([rin, '--config', rcfg]);
assert.strictEqual(bad.status, 4);
assert.ok(/Ledger at .* could not be read \(.*\)\. Open Loops did not change it\. Only its owner should decide whether to move it aside or restore it: deleting it loses every verdict recorded so far\./.test(bad.stderr), bad.stderr);
assert.ok(!/to start fresh/.test(bad.stderr), 'it no longer tells anyone to start fresh');
// The salt: a same-day re-run cannot get round the guard.
fs.unlinkSync(rled);
var SAL = 'Ledger at ' + rled + ' holds person identifiers but no identity salt. Restore the file it was copied from. Open Loops did not make a new salt: it would detach every person from their corrections.';
var sw = function () {
  var x = tmp(), cfg = path.join(x, 'c.json'), led = path.join(x, 'ledger.json'), inp = path.join(x, 'in.json');
  fs.writeFileSync(cfg, JSON.stringify({ you: ME, selfDm: 'U0EXAMPLE001', tzOffset: 0, spotCheck: 0, ledger: led, channels: { include: ['#ops'] } }));
  var banner = function (t, who, id, name, body) { return '=== Message from ' + name + ' <' + who + '> (' + id + ') at ' + t + ' UTC ===' + NL + 'Message TS: ' + t + NL + body; };
  var chat = banner(ts(9, 30, 9), 'lena@vf.example', 'U0EXAMPLE002', 'Lena Borg', 'Please send the deck Thursday Oct 1.') + NL + banner(ts(9, 30, 10), 'sam@acme.example', 'U0EXAMPLE003', 'Sam Okafor', 'Please send the deck Thursday Oct 1.');
  fs.writeFileSync(inp, JSON.stringify({ today: '2026-10-01', conversations: [{ channel: '#ops', members: [], text: chat, complete: true }], dm: { channel: 'D0', text: '' } }));
  return { dir: x, cfg: cfg, led: led, inp: inp, text: function () { return fs.readFileSync(led, 'utf8'); } };
};
var sx = sw();
assert.strictEqual(runner([sx.inp, '--config', sx.cfg]).status, 0, 'a first run');
var withSalt = JSON.parse(sx.text());
assert.ok(withSalt.rows.some(function (r) { return /^[0-9a-f]{64}$/.test(r[8]); }), 'two people with one sentence have identity tokens');
delete withSalt.identitySalt; fs.writeFileSync(sx.led, JSON.stringify(withSalt));
var lost = sx.text();
var same = runner([sx.inp, '--config', sx.cfg]);                                            // the same day: it used to make a new salt and rewrite the ledger
assert.strictEqual(same.status, 4, 'a same-day re-run gets the same answer as any other day: ' + same.stderr);
assert.ok(same.stderr.indexOf('Open Loops did not make a new salt: it would detach every person from their corrections.') > -1, same.stderr);
assert.strictEqual(sx.text(), lost, 'and the ledger is untouched');
assert.strictEqual(runner([sx.inp, '--config', sx.cfg, '--dry']).status, 4, 'a preview too');
assert.strictEqual(runner([sx.inp, '--config', sx.cfg, '--today', '2026-10-02']).status, 4, 'and the next day');
assert.strictEqual(sx.text(), lost);
assert.strictEqual(runner([sx.inp, '--config', sx.cfg, '--check']).status, 0, 'a check still reads it without a salt, and writes nothing');
assert.strictEqual(sx.text(), lost);

/* ============================== 5. restores.json, and restore records in the ledger ============================== */
var banner = function (t, body) { return '=== Message from Lena Borg <lena@vf.example> (U0EXAMPLE002) at ' + t + ' UTC ===' + NL + 'Message TS: ' + t + NL + body; };
var fenced = function (t, d) { return banner(t, '```' + NL + d + NL + '```'); };
var world = function () {
  var dir = tmp(), cfg = path.join(dir, 'openloops.config.json'), ledger = path.join(dir, 'ledger.json'), n = 0;
  fs.writeFileSync(cfg, JSON.stringify({ you: ME, selfDm: 'U0EXAMPLE001', tzOffset: 0, spotCheck: 0, ledger: ledger, channels: { include: ['#ops'] } }));
  var chat = ['alpha', 'bravo', 'charlie'].map(function (w, i) { return banner(ts(9, 25 + i, 10), 'Please send the ' + w + ' report Thursday Oct 1.'); }).join(NL);
  var w = { dir: dir, cfg: cfg, ledger: ledger,
    run: function (today, extra) { var p = path.join(dir, 'in' + (n++) + '.json'); fs.writeFileSync(p, JSON.stringify(Object.assign({ today: today, conversations: [{ channel: '#ops', members: [], text: chat, complete: true }], dm: { channel: 'D0', text: '' } }, extra || {}))); return main([p, '--config', cfg]); },
    data: function () { return JSON.parse(fs.readFileSync(ledger, 'utf8')); },
    corr: function (a) { return corr.main(a.concat(['--config', cfg])); },
    req: function () { return path.join(dir, 'restores.json'); } };
  return w;
};
var rejectedWorld = function () {
  var x = world();
  x.dg1 = x.run('2026-09-30'); x.t1 = ts(9, 30, 22);
  x.n1 = x.dg1.split(NL).map(function (l) { return l.match(/^ ?(\d+) {2}.*alpha/); }).filter(Boolean)[0][1];
  var R1 = banner(ts(10, 1, 9), x.n1);
  x.dgA = x.run('2026-10-01', { dm: { channel: 'D0', text: fenced(x.t1, x.dg1) }, dmThread: [{ root: x.t1, text: fenced(x.t1, x.dg1) + NL + R1 }] });
  var st = x.data(); x.key = st.refs[x.dg1.match(/· ref ([0-9a-f]{4})/)[1]].keys[+x.n1 - 1];
  x.ref = Object.keys(st.restoreRefs).filter(function (r) { return st.restoreRefs[r].key === x.key; })[0];
  x.digestRef = x.dg1.match(/· ref ([0-9a-f]{4})/)[1];
  x.again = function (today) { return x.run(today || '2026-10-01', { dm: { channel: 'D0', text: fenced(x.t1, x.dg1) + NL + fenced(ts(10, 1, 18), x.dgA) }, dmThread: [{ root: x.t1, text: fenced(x.t1, x.dg1) + NL + R1 }] }); };
  return x;
};
var DAMAGED = 'RESTORE REQUESTS NOT PROCESSED — restores.json could not be read, so no queued restore was applied. The file was preserved. Ask your assistant to inspect it.';
// One request that is not whole makes the whole file unusable: it is not dropped, and the file is untouched.
var v = rejectedWorld();
var okReq = { id: 'aaaa0001', ref: v.ref, requestedAt: '2026-10-01T19:00:00.000Z' };
[[{ id: 'bbbb0002', ref: v.ref, requestedAt: 5 }], [{ id: 'bbbb0002', ref: v.ref, requestedAt: 'yesterday' }], [{ id: 'bbbb0002', ref: v.ref }], [{ id: 'nothex', ref: v.ref, requestedAt: '2026-10-01T19:00:00.000Z' }]].forEach(function (bad) {
  var text = JSON.stringify({ requests: [okReq].concat(bad) });
  fs.writeFileSync(v.req(), text);
  assert.ok(v.again().split(NL).indexOf(DAMAGED) > -1, JSON.stringify(bad) + ': the digest says the file cannot be used');
  assert.strictEqual(v.data().restoreLog['aaaa0001'], undefined, 'and the valid request beside it is not half-applied');
  assert.throws(function () { v.corr(['--restore', v.ref]); }, /restores\.json could not be read, so nothing was queued\. The file was preserved\./);
  assert.strictEqual(fs.readFileSync(v.req(), 'utf8'), text, 'the file is left exactly as it is');
});
// One item asked for two ways is one request.
var dup = rejectedWorld();
var q1 = dup.corr(['--restore', dup.ref, '--now', '2026-10-01T19:00']);
var q2 = dup.corr(['--restore-item', dup.n1, '--digest', dup.digestRef, '--now', '2026-10-01T19:01']);
assert.ok(/^Restore requested for /.test(q1) && /^Restore already requested for /.test(q2), 'the second is the same request: ' + q2);
assert.strictEqual(JSON.parse(fs.readFileSync(dup.req(), 'utf8')).requests.length, 1);
// If both did get into the file (an older tool, a hand edit), the digest gives one note, and every request id gets a terminal result.
var two = rejectedWorld();
fs.writeFileSync(two.req(), JSON.stringify({ requests: [{ id: 'aaaa0001', ref: two.ref, requestedAt: '2026-10-01T19:00:00.000Z' }, { id: 'aaaa0002', digest: { ref: two.digestRef, n: +two.n1 }, requestedAt: '2026-10-01T19:01:00.000Z' }] }));
var dgTwo = two.again();
assert.strictEqual(dgTwo.split(NL).filter(function (l) { return /Restored 1 item you had rejected|Restore applied|NOT RESTORED/.test(l); }).length, 1, 'one note: ' + dgTwo.split(NL).slice(0, 8).join(' / '));
var logTwo = two.data().restoreLog;
assert.strictEqual(logTwo.aaaa0001.state, 'applied'); assert.strictEqual(logTwo.aaaa0002.state, 'applied');
assert.strictEqual(logTwo.aaaa0002.duplicateOf, 'aaaa0001'); assert.strictEqual(logTwo.aaaa0002.acked, true, 'the duplicate says nothing of its own');
// Neither can apply again: the item is rejected once more, and a later run leaves it so.
var rowTwo = function () { return two.data().rows.filter(function (r) { return r[L.COL.key] === two.key; })[0]; };
assert.strictEqual(rowTwo()[L.COL.verdict], '');
var led2 = two.data(); led2.rows.forEach(function (r) { if (r[L.COL.key] === two.key) r[L.COL.verdict] = 'x'; }); fs.writeFileSync(two.ledger, JSON.stringify(led2));
two.run('2026-10-03');
assert.strictEqual(rowTwo()[L.COL.verdict], 'x', 'a later rejection stands: neither request applies again');
// A damaged restore record in the ledger is a damaged ledger.
var cr = rejectedWorld();
var cases = [
  ['restoreLog', function (l) { l.restoreLog.deadbeef = null; }, 'restoreLog entry "deadbeef" is not valid'],
  ['restoreLog', function (l) { l.restoreLog.deadbeef = { state: 'applied', key: 'k', requestedAt: '2026-10-01T10:00:00.000Z', shownRefs: 5 }; }, 'restoreLog entry "deadbeef" is not valid'],
  ['restoreLog', function (l) { l.restoreLog.deadbeef = {}; }, 'restoreLog entry "deadbeef" is not valid'],
  ['restoreRefs', function (l) { l.restoreRefs.abcd1234 = null; }, 'restoreRefs entry "abcd1234" is not valid'],
  ['restoreRefs', function (l) { l.restoreRefs = []; }, 'restoreRefs must be an object'],
  ['replyHashes', function (l) { l.replyHashes['1.1'] = 5; }, 'replyHashes entry "1.1" is not valid']
];
cases.forEach(function (c) {
  var good = fs.readFileSync(cr.ledger, 'utf8'), led = JSON.parse(good); c[1](led);
  fs.writeFileSync(cr.ledger, JSON.stringify(led));
  var broken = fs.readFileSync(cr.ledger, 'utf8');
  var err = caught(function () { cr.again(); });
  assert.strictEqual(err.exitCode, 4, c[2] + ': a damaged ledger, exit 4');
  assert.ok(err.message.indexOf('could not be read (' + c[2] + ')') > -1, err.message);
  assert.strictEqual(fs.readFileSync(cr.ledger, 'utf8'), broken, 'and it is untouched');
  fs.writeFileSync(cr.ledger, good);
});
cr.again();      // and a whole one is fine

/* ============================== 6. temporary files, and "v2" ============================== */
var tw = tmp(), tcfg = path.join(tw, 'c.json'), other = path.join(tw, 'ledger.json.99999.abcdef.tmp');
fs.writeFileSync(other, 'another operation\'s file');
var st6 = fileStore(path.join(tw, 'ledger.json'));
var flushErr = failing('rename', 'EPERM', function () { return caught(function () { st6.writeLedger([]); }); });
assert.strictEqual(flushErr.code, 'EPERM');
assert.deepStrictEqual(tmps(tw), ['ledger.json.99999.abcdef.tmp'], 'a failed ledger write removes its own file and not another operation\'s');
var failW = failing('write', 'EACCES', function () { return caught(function () { st6.writeLedger([]); }); });
assert.deepStrictEqual(tmps(tw), ['ledger.json.99999.abcdef.tmp']);
var rdir6 = tmp(); fs.writeFileSync(path.join(rdir6, 'ledger.json.1.aaaaaa.tmp'), 'other');
// restores.json: the tool's own write
var rw = rejectedWorld();
fs.writeFileSync(path.join(rw.dir, 'restores.json.1.ffffff.tmp'), 'other');
var errR = failing('rename', 'EPERM', function () { return caught(function () { rw.corr(['--restore', rw.ref, '--now', '2026-10-01T19:00']); }); });
assert.deepStrictEqual(tmps(rw.dir), ['restores.json.1.ffffff.tmp'], 'and so does the restore tool');
assert.ok(!fs.existsSync(rw.req()), 'and nothing was queued');
['v2', 'Q3', 'x2', 'abc12', 'H1 plan'].forEach(function (t) {
  var r = L.parseMarks(t, 8);
  assert.deepStrictEqual([r.wrong, r.ignored], [[], []], JSON.stringify(t) + ' names no item');
});
assert.strictEqual(L.parseMarks('call Dana at 3', 8).ignored.length, 1, 'a note with a real number in it is still reported');
assert.deepStrictEqual(L.parseMarks('3 7', 8).wrong, [3, 7]);

console.log('persistence: OK');
