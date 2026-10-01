/* The fixes from the last adversarial run.
 *
 *  1. keepLedgerDays, lookbackDays and ledger values that used to pass --check-config and then wipe the ledger or crash the run.
 *  2. A same-day re-run after a key migration must not undo a restore (the keys the rollback does not roll back are put back too).
 *  3. "1,000 dollars" and "1,5 hours" are quantities; "3,7" and "3, 7" are lists. A mixed paste is a paste. Held replies beyond three are counted.
 *  4. An --end that exits 5 says where its notice goes and not to record a result for it; contradictory facts are refused.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');
var cli = require('../tools/status.js');
var L = require('../src/ledger.js');
var S = require('../src/status.js');
var loops = require('../src/loops.js');
var { fileStore } = require('../src/store.js');
var { main, marksFromDm } = require('../slack-run.js');
var corr = require('../tools/corrections.js');

var ROOT = path.join(__dirname, '..'), NL = String.fromCharCode(10), ME = 'alex@example.com';
var tmp = function () { return fs.mkdtempSync(path.join(os.tmpdir(), 'ol-final-')); };
var runner = function (args) { return cp.spawnSync(process.execPath, [path.join(ROOT, 'slack-run.js')].concat(args), { encoding: 'utf8', cwd: ROOT }); };
var ts = function (mo, d, h, mi) { return (Date.UTC(2026, mo - 1, d, h, mi || 0) / 1000).toFixed(6); };

/* ============================== 1. config values ============================== */
var INPUT = JSON.stringify({ today: '2026-10-01', conversations: [{ channel: '#ops', members: [], text: '', complete: true }], dm: { channel: 'D0', text: '' } });
var GOOD = { you: 'you@example.com', selfDm: 'U0EXAMPLE001' };
var FIX = ' Fix the configuration before fetching or running a digest.';
var configCase = function (extra, raw) {
  var d = tmp(), c = path.join(d, 'c.json'), i = path.join(d, 'in.json');
  fs.writeFileSync(c, raw != null ? raw : JSON.stringify(Object.assign({}, GOOD, { ledger: path.join(d, 'ledger.json') }, extra))); fs.writeFileSync(i, INPUT);
  return { dir: d, c: c, i: i, check: runner(['--check-config', '--config', c]), run: runner([i, '--config', c, '--dry']) };
};
var DAYS_LOOK = '"lookbackDays" must be a number of days from 0 to 3650 (0 reads without a window), got ';
var DAYS_KEEP = '"keepLedgerDays" must be a number of days, 0 or more (0 keeps every row), got ';
[
  [{ keepLedgerDays: 'abc' }, DAYS_KEEP + '"abc"'], [{ keepLedgerDays: -1 }, DAYS_KEEP + '-1'], [{ keepLedgerDays: {} }, DAYS_KEEP + '{}'], [{ keepLedgerDays: [] }, DAYS_KEEP + '[]'], [{ keepLedgerDays: true }, DAYS_KEEP + 'true'],
  [{ lookbackDays: 1e308 }, DAYS_LOOK + '1e+308'], [{ lookbackDays: 3651 }, DAYS_LOOK + '3651'], [{ lookbackDays: 999999999999 }, DAYS_LOOK + '999999999999'],
  [{ lookbackDays: 'x' }, DAYS_LOOK + '"x"'], [{ lookbackDays: -1 }, DAYS_LOOK + '-1'],
  [{ ledger: null }, '"ledger" must be a file path, got null'], [{ ledger: 5 }, '"ledger" must be a file path, got 5'], [{ ledger: '' }, '"ledger" must be a file path, got ""'],
  [{ ledger: 'a' + String.fromCharCode(0) + 'b' }, '"ledger" must be a file path, got "a\\u0000b"'], [{ ledger: new Array(4100).join('x') }, null]
].forEach(function (c) {
  var r = configCase(c[0]);
  assert.strictEqual(r.check.status, 3, JSON.stringify(c[0]).slice(0, 60) + ': the check refuses it: ' + r.check.stdout + r.check.stderr);
  if (c[1]) assert.strictEqual(r.check.stderr.trim(), 'open-loops: Config is unusable: ' + c[1] + '.' + FIX);
  assert.strictEqual(r.run.status, 3, JSON.stringify(c[0]).slice(0, 60) + ': and so does the run, as a configuration problem: ' + r.run.stderr.slice(0, 200));
});
[{ keepLedgerDays: 0 }, { keepLedgerDays: 90 }, { keepLedgerDays: '90' }, { keepLedgerDays: null }, { lookbackDays: 0 }, { lookbackDays: 3650 }, { lookbackDays: '21' }].forEach(function (extra) {
  var r = configCase(extra);
  assert.strictEqual(r.check.status, 0, JSON.stringify(extra) + ': ' + r.check.stderr);
  assert.strictEqual(r.run.status, 0, JSON.stringify(extra) + ' runs: ' + r.run.stderr);
});
// The reproduced loss: a bad retention value used to empty the ledger on the next run. Now the run is refused and the ledger is as it was.
var keep = configCase({});
assert.strictEqual(runner([keep.i, '--config', keep.c]).status, 0);
var ledgerPath = path.join(keep.dir, 'ledger.json'), before = fs.readFileSync(ledgerPath, 'utf8');
var chat = '=== Message from Lena Borg <lena@vf.example> (U0EXAMPLE002) at ' + ts(9, 30, 9) + ' UTC ===' + NL + 'Message TS: ' + ts(9, 30, 9) + NL + "I'll send the deck Thursday Oct 1.";
fs.writeFileSync(keep.i, JSON.stringify({ today: '2026-10-01', conversations: [{ channel: '#ops', members: [], text: chat, complete: true }], dm: { channel: 'D0', text: '' } }));
assert.strictEqual(runner([keep.i, '--config', keep.c]).status, 0);
var withRows = fs.readFileSync(ledgerPath, 'utf8');
assert.ok(JSON.parse(withRows).rows.length > 0, 'the ledger has a row');
fs.writeFileSync(keep.c, JSON.stringify(Object.assign({}, GOOD, { ledger: ledgerPath, keepLedgerDays: 'abc' })));
var refusedRun = runner([keep.i, '--config', keep.c, '--today', '2026-10-02']);
assert.strictEqual(refusedRun.status, 3);
assert.strictEqual(fs.readFileSync(ledgerPath, 'utf8'), withRows, 'and the ledger is untouched, not emptied');

/* ============================== 2. a same-day re-run after a key migration ============================== */
var h = {
  banner: function (t, body) { return '=== Message from Lena Borg <lena@vf.example> (U0EXAMPLE002) at ' + t + ' UTC ===' + NL + 'Message TS: ' + t + NL + body; }
};
var fenced = function (t, d) { return h.banner(t, '```' + NL + d + NL + '```'); };
var ROOT_TS = '1790000000.000100', DECK = "I'll send the deck by Sep 30.";
var world = function () {
  var dir = tmp(), cfg = path.join(dir, 'openloops.config.json'), ledger = path.join(dir, 'ledger.json'), n = 0;
  fs.writeFileSync(cfg, JSON.stringify({ you: ME, selfDm: 'U0EXAMPLE001', tzOffset: 0, spotCheck: 0, ledger: ledger, channels: { include: ['#ops'] } }));
  var w = {
    dir: dir, cfg: cfg, ledger: ledger,
    run: function (today, extra, incomplete) {
      var p = path.join(dir, 'in' + (n++) + '.json');
      var th = [{ channel: '#ops', root: ROOT_TS, members: [], complete: true, text: h.banner(ts(9, 29, 10), DECK) }];
      fs.writeFileSync(p, JSON.stringify(Object.assign({ today: today, conversations: [{ channel: '#ops', members: [], text: '', complete: !incomplete }], threads: th, dm: { channel: 'D0', text: '' } }, extra || {})));
      return main([p, '--config', cfg]);
    },
    data: function () { return JSON.parse(fs.readFileSync(ledger, 'utf8')); },
    save: function (d) { fs.writeFileSync(ledger, JSON.stringify(d)); },
    corr: function (a) { return corr.main(a.concat(['--config', cfg])); }
  };
  w.d1 = w.run('2026-09-30'); w.t1 = ts(9, 30, 22);
  w.n1 = (w.d1.split(NL).map(function (l) { return l.match(/^ ?(\d+) {2}.*deck/); }).filter(Boolean)[0] || [])[1];
  w.R1 = h.banner(ts(10, 1, 9), w.n1);
  w.dm = function () { return { channel: 'D0', text: fenced(w.t1, w.d1) }; };
  w.thr = function () { return [{ root: w.t1, text: fenced(w.t1, w.d1) + NL + w.R1 }]; };
  w.dA = w.run('2026-10-01', { dm: w.dm(), dmThread: w.thr() });
  /* The ledger as an older version wrote it: the row, the digest memos and the reference carry the pre-channel key. */
  w.legacy = function () {
    var d = w.data(), K = d.rows[0][0], LK = loops.legacyKey(K);
    d.rows[0][0] = LK;
    Object.keys(d.digests).forEach(function (k) { d.digests[k] = d.digests[k].map(function (x) { return x === K ? LK : x; }); });
    Object.keys(d.refs).forEach(function (k) { if (d.refs[k].keys) d.refs[k].keys = d.refs[k].keys.map(function (x) { return x === K ? LK : x; }); });
    Object.keys(d.restoreRefs).forEach(function (r) { if (d.restoreRefs[r].key === K) d.restoreRefs[r].key = LK; });
    w.save(d); return { K: K, LK: LK };
  };
  w.row = function () { return w.data().rows[0]; };
  return w;
};
var localNow = function (mo, d, hh, mi) {
  var x = new Date(Date.UTC(2026, mo - 1, d, hh, mi || 0)), p = function (v) { return (v < 10 ? '0' : '') + v; };
  return x.getFullYear() + '-' + p(x.getMonth() + 1) + '-' + p(x.getDate()) + 'T' + p(x.getHours()) + ':' + p(x.getMinutes());
};
var rw = world();
var keys = rw.legacy();
assert.ok(rw.data().rows[0][0] === keys.LK && keys.LK !== keys.K, 'the ledger holds the older key');
rw.run('2026-10-01', { dm: rw.dm(), dmThread: rw.thr() }, true);            // an incomplete read: the row stays under its older key and keeps its reference
var ref = Object.keys(rw.data().restoreRefs)[0];
assert.ok(ref && rw.data().restoreRefs[ref].key === keys.LK, 'the reference is on the older key');
assert.ok(/^Restore requested/.test(rw.corr(['--restore', ref, '--now', localNow(10, 1, 19)])));
var first = rw.run('2026-10-02', { dm: rw.dm(), dmThread: rw.thr() });       // restore applied, and the row migrated to the current key
assert.ok(/Restored 1 item you had rejected/.test(first), first.split(NL).slice(0, 6).join(' / '));
assert.strictEqual(rw.row()[0], keys.K, 'the row is under its current key now');
assert.strictEqual(rw.row()[7], '');
// The same-day re-run: it used to put the older key back on the rows only, and then report that the reader had rejected it again.
['rerun 1', 'rerun 2', 'rerun 3'].forEach(function (label) {
  var again = rw.run('2026-10-02', { dm: rw.dm(), dmThread: rw.thr() });
  assert.strictEqual(rw.row()[7], '', label + ': still restored');
  assert.ok(!/rejected it again|hidden as wrong/.test(again), label + ': no claim that it was rejected again: ' + again.split(NL).slice(0, 5).join(' / '));
  assert.ok(/1 open/.test(again), label + ': and it is listed');
  assert.strictEqual(rw.row()[0], keys.K, label + ': under the current key');
  assert.strictEqual(rw.data().restoreRefs[ref].key, keys.K, label + ': its reference follows');
  var log = rw.data().restoreLog, id = Object.keys(log)[0];
  assert.strictEqual(log[id].superseded, false, label + ': the restore was not superseded by anything');
});
var next = rw.run('2026-10-03', { dm: rw.dm(), dmThread: rw.thr() });
assert.strictEqual(rw.row()[7], '', 'the next day it is still restored');
assert.ok(!/rejected it again/.test(next));
assert.ok(/applied Oct 2(?!, then)/.test(rw.corr(['--list'])) || /RESTORE REQUESTS/.test(rw.corr(['--list'])), 'the list does not say it was rejected again');
assert.ok(!/then you rejected it again/.test(rw.corr(['--list'])));

// The store, on its own: renames made since the snapshot are undone by a rollback, however many there were, in one step.
var sd = tmp(), file = path.join(sd, 'l.json');
var s1 = fileStore(file);
s1.writeLedger([['A', '2026-09-01', '2026-09-30', '', 'owed_by_us', '', '', 'x']]);
s1.beginRun('2026-10-01');
var st = s1.restoreState();
st.refs.aaaa1111 = { key: 'A', on: '2026-09-30' };
st.log.bbbb2222 = { state: 'applied', key: 'A', requestedAt: '2026-10-01T10:00:00.000Z', on: '2026-10-01' };
s1.rememberRef('cccc', '2026-09-30', ['A']);
s1.migrateKeys({ A: 'B' });
s1.migrateKeys({ B: 'C' });                  // a chain: A -> B -> C in one run
assert.strictEqual(st.refs.aaaa1111.key, 'C');
s1.writeLedger([['C', '2026-09-01', '2026-09-30', '', 'owed_by_us', '', '', 'x']]);
var s2 = fileStore(file);
s2.beginRun('2026-10-01');                    // a same-day re-run: rows go back to A
assert.strictEqual(s2.readLedger()[0][0], 'A', 'the rows are back to the snapshot');
var st2 = s2.restoreState();
assert.strictEqual(st2.refs.aaaa1111.key, 'A', 'and so is the reference, through the whole chain');
assert.strictEqual(st2.log.bbbb2222.key, 'A', 'and the log');
assert.deepStrictEqual(s2.recallRef('cccc').keys, ['A'], 'and the digest memo');
s2.migrateKeys({ A: 'B' });                   // the re-run migrates again, differently this time
assert.strictEqual(st2.refs.aaaa1111.key, 'B');
s2.writeLedger([['B', '2026-09-01', '2026-09-30', '', 'owed_by_us', '', '', 'x']]);
var s3 = fileStore(file);
s3.beginRun('2026-10-01');                    // and again
assert.strictEqual(s3.readLedger()[0][0], 'A');
assert.strictEqual(s3.restoreState().refs.aaaa1111.key, 'A', 'repeated rollbacks stay consistent');
s3.restoreState().refs.dddd0004 = { key: 'B', on: '2026-10-01' };       // a reference to a row that is genuinely keyed B
s3.writeLedger([['A', '2026-09-01', '2026-09-30', '', 'owed_by_us', '', '', 'x']]);
var s4 = fileStore(file);
s4.beginRun('2026-10-01');                    // a rollback with nothing renamed since the last one changes nothing
assert.strictEqual(s4.restoreState().refs.aaaa1111.key, 'A');
assert.strictEqual(s4.restoreState().refs.dddd0004.key, 'B', 'a rename that was already undone is not undone again');
// Two keys renamed to one cannot be told apart on the way back, and are left rather than guessed.
var s5 = fileStore(path.join(sd, 'm.json'));
s5.writeLedger([['P', '', '', '', '', '', '', ''], ['Q', '', '', '', '', '', '', '']]);
s5.beginRun('2026-10-01'); s5.restoreState().refs.rrrr0001 = { key: 'P', on: '2026-09-30' }; s5.restoreState().refs.rrrr0002 = { key: 'Q', on: '2026-09-30' };
s5.migrateKeys({ P: 'M', Q: 'M' });
s5.writeLedger([['M', '', '', '', '', '', '', '']]);
var s6 = fileStore(path.join(sd, 'm.json')); s6.beginRun('2026-10-01');
assert.strictEqual(s6.restoreState().refs.rrrr0001.key, 'M', 'an ambiguous way back is not guessed');
// A new day's rollback does not happen at all: nothing is undone.
var s7 = fileStore(path.join(sd, 'm.json')); s7.beginRun('2026-10-02');
assert.strictEqual(s7.restoreState().refs.rrrr0001.key, 'M');

/* ============================== 3. quantities, lists, and pastes ============================== */
var marks = function (t, max) { var r = L.parseMarks(t, max || 8); return { wrong: r.wrong, knew: r.knew, ignored: r.ignored.length, unread: r.unread.length }; };
var none = { wrong: [], knew: [], ignored: 0, unread: 0 };
['1,000 dollars', '1,5 hours', '9,5 kg', '2,5 hours later', 'k 1,5 hours', '1,234,567 views', '3,000 people came'].forEach(function (t) {
  assert.deepStrictEqual(marks(t), none, JSON.stringify(t) + ' is a quantity: no marks, nothing reported');
});
assert.deepStrictEqual(marks('1,000').wrong.concat(marks('3,000').wrong), [], 'a bare thousands number marks nothing (it is reported as not read, like any bare number past the list)');
assert.deepStrictEqual(marks('3,7'), { wrong: [3, 7], knew: [], ignored: 0, unread: 0 }, '"3,7" is a list');
assert.deepStrictEqual(marks('3, 7'), { wrong: [3, 7], knew: [], ignored: 0, unread: 0 }, 'and so is "3, 7"');
assert.deepStrictEqual(marks('2,5'), { wrong: [2, 5], knew: [], ignored: 0, unread: 0 });
assert.deepStrictEqual(marks('1,5\nk 2,3'), { wrong: [1, 5], knew: [2, 3], ignored: 0, unread: 0 }, 'each line on its own, k included');
assert.deepStrictEqual(marks('3 and 7 arent real'), { wrong: [3, 7], knew: [], ignored: 0, unread: 0 }, 'as ever');
assert.deepStrictEqual(marks('3, 7 and 1,000 dollars'), { wrong: [3, 7], knew: [], ignored: 0, unread: 0 }, 'a thousands group beside a list is only a quantity');
// The paste guard counts both kinds together.
var keys8 = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8'], store = {
  seenReplies: function () { return []; }, refsSince: function () { return '2026-09-22'; },
  recallRef: function (r) { return r === 'cccc' ? { date: '2026-09-23', keys: keys8, asked: [] } : null; }
};
var rows8 = function () { return keys8.map(function (k) { return [k, '2026-09-01', '2026-09-23', '', 'owed_by_us', '', '', '']; }); };
var head = { id: '100.1', threadId: '100.1', body: 'OPEN LOOPS — for 2026-09-23 · ref cccc' + NL + 'x' };
var replies = function (bodies) {
  var rows = rows8(), msgs = [head].concat(bodies.map(function (b, i) { return { id: (200 + i) + '.1', threadId: '100.1', body: b }; }));
  var r = marksFromDm(msgs, store, rows);
  return { r: r, verdicts: rows.map(function (x) { return x[7] || '-'; }).join('') };
};
var mixed = replies(['1 2 3\nk 4 5 6']);
assert.strictEqual(mixed.verdicts, '--------', 'three rejections and three "known" over eight items are one paste: nothing applied');
assert.deepStrictEqual([mixed.r.mass[0].kind, mixed.r.mass[0].count, mixed.r.mass[0].wrong, mixed.r.mass[0].knew], ['marks', 6, 3, 3]);
assert.strictEqual(replies(['1 2\nk 3']).verdicts, 'xxk-----', 'three marks of eight is a correction');
assert.strictEqual(replies(['1 2\nk 3 4']).verdicts, 'xxkk----', 'four of eight is not more than half');
assert.strictEqual(replies(['1 2\nk 3 4 5']).verdicts, '--------', 'five of eight is');
assert.strictEqual(replies(['1 2 3 4 5']).r.mass[0].kind, undefined, 'five rejections alone keep their own wording');
assert.strictEqual(replies(['k 1 2 3 4 5']).r.mass[0].kind, 'known', 'and so do five "known"');
// Rendered, with the lines held back beyond the third counted.
var many = function () {
  var dir = tmp(), cfg = path.join(dir, 'c.json'), ledger = path.join(dir, 'ledger.json'), n = 0;
  fs.writeFileSync(cfg, JSON.stringify({ you: ME, selfDm: 'U0EXAMPLE001', tzOffset: 0, spotCheck: 0, ledger: ledger, channels: { include: ['#ops'] } }));
  var words = 'alpha bravo charlie delta echo foxtrot golf hotel'.split(' ');
  var chatText = words.map(function (w, i) { return h.banner(ts(9, 28, 1 + i), 'Please send the ' + w + ' report Thursday Oct 1.'); }).join(NL);
  return { run: function (today, extra) { var p = path.join(dir, 'i' + (n++) + '.json'); fs.writeFileSync(p, JSON.stringify(Object.assign({ today: today, conversations: [{ channel: '#ops', members: [], text: chatText, complete: true }], dm: { channel: 'D0', text: '' } }, extra || {}))); return main([p, '--config', cfg]); } };
};
var mw = many();
var dg = mw.run('2026-09-30'), tm = ts(9, 30, 22);
var thread = function (bodies) { return [{ root: tm, text: fenced(tm, dg) + NL + bodies.map(function (b, i) { return h.banner(ts(10, 1, 9 + i), b); }).join(NL) }]; };
var out1 = mw.run('2026-10-01', { dm: { channel: 'D0', text: fenced(tm, dg) }, dmThread: thread(['1 2 3\nk 4 5 6']) });
assert.ok(out1.split(NL).indexOf('NOT APPLIED — "1 2 3" would mark 6 of 8 items at once (3 not real, 3 already known), which looks like something pasted into the DM rather than a correction. Reply with fewer numbers if you meant it.') > -1, out1.split(NL).slice(0, 8).join(' / '));
var mw2 = many(); var dg2 = mw2.run('2026-09-30');
var th2 = function (bodies) { return [{ root: tm, text: fenced(tm, dg2) + NL + bodies.map(function (b, i) { return h.banner(ts(10, 1, 9 + i), b); }).join(NL) }]; };
var out5 = mw2.run('2026-10-01', { dm: { channel: 'D0', text: fenced(tm, dg2) }, dmThread: th2(['1-8', '2-8', '3-8', '4-8', '1-7']) });
assert.strictEqual(out5.split(NL).filter(function (l) { return /^NOT APPLIED/.test(l); }).length, 3, 'three held replies are shown');
assert.ok(out5.split(NL).indexOf('+ 2 more replies were not applied because they looked like pastes.') > -1, out5.split(NL).slice(0, 9).join(' / '));
var mw3 = many(); var dg3 = mw3.run('2026-09-30');
var out4 = mw3.run('2026-10-01', { dm: { channel: 'D0', text: fenced(tm, dg3) }, dmThread: [{ root: tm, text: fenced(tm, dg3) + NL + ['1-8', '2-8', '3-8', '4-8'].map(function (b, i) { return h.banner(ts(10, 1, 9 + i), b); }).join(NL) }] });
assert.ok(out4.split(NL).indexOf('+ 1 more reply was not applied because it looked like a paste.') > -1, 'singular: ' + out4.split(NL).slice(0, 9).join(' / '));
assert.ok(mw3.run('2026-10-02').indexOf('more repl') === -1, 'nothing counted when nothing was held');

/* ============================== 4. exit 5 says where the notice goes; contradictory facts ============================== */
var failing = function (fn) {
  var realW = fs.writeFileSync;
  fs.writeFileSync = function (f) { if (/\.tmp$/.test(String(f))) { var e = new Error('EACCES: simulated'); e.code = 'EACCES'; throw e; } return realW.apply(fs, arguments); };
  try { return fn(); } finally { fs.writeFileSync = realW; }
};
var caught = function (fn) { try { fn(); } catch (e) { return e; } assert.fail('expected a failure'); };
var cfgOf = function (d) { return path.join(d, 'c.json'); };
var ONCE = 'This notice is the only one for this attempt: post it once, and do not run --end again. Tell the user the attempt could not be recorded.';
var NO_RESULT = 'Do not run --notice-result for this attempt: its notice result cannot be recorded.';
var d4 = tmp(), id4 = cli.main(['--begin', '--today', '2026-10-01', '--config', cfgOf(d4)]).match(/ATTEMPT ([0-9a-f]+)/)[1];
var partial = ['--end', '--attempt', id4, '--config', cfgOf(d4), '--brief', 'posted', '--details', 'rejected', '--verified', 'no', '--failed', 'post'];
var e4 = failing(function () { return caught(function () { cli.main(partial, function () {}); }); });
assert.ok(/^OPEN LOOPS NOTES — for 2026-10-01/.test(e4.stdout), e4.stdout);
var lines4 = e4.message.split(NL);
assert.strictEqual(lines4.length, 4, 'the persistence message, then three instructions, each on its own line: ' + JSON.stringify(lines4));
assert.strictEqual(lines4[1], 'post: the thread under the brief', 'a partial notice goes in the brief\'s thread');
assert.strictEqual(lines4[2], ONCE); assert.strictEqual(lines4[3], NO_RESULT);
var d4b = tmp(), id4b = cli.main(['--begin', '--today', '2026-10-01', '--config', cfgOf(d4b)]).match(/ATTEMPT ([0-9a-f]+)/)[1];
var e4b = failing(function () { return caught(function () { cli.main(['--end', '--attempt', id4b, '--config', cfgOf(d4b), '--brief', 'not_attempted', '--details', 'not_attempted', '--verified', 'no', '--failed', 'build'], function () {}); }); });
assert.strictEqual(e4b.message.split(NL)[1], 'post: your own DM', 'any other notice goes to the own DM');
var e4c = caught(function () { cli.main(['--end', '--attempt', 'UNRECORDED', '--today', '2026-10-01', '--config', cfgOf(tmp()), '--brief', 'rejected', '--details', 'not_attempted', '--verified', 'no', '--failed', 'post'], function () {}); });
assert.ok(e4c.message.split(NL).indexOf('post: your own DM') > -1 && e4c.message.split(NL).indexOf(NO_RESULT) > -1, 'an attempt with no record says the same: ' + e4c.message);
assert.ok(/post it where the `post:` line says \(the brief's thread for an `OPEN LOOPS NOTES` notice, your own DM otherwise\), and skip `--notice-result`/i.test(fs.readFileSync(path.join(ROOT, 'skills', 'open-loops', 'SKILL.md'), 'utf8').split(String.fromCharCode(13)).join('').replace(/\s+/g, ' ')), 'SKILL.md says so too');
// Contradictory facts: refused, nothing recorded.
var dc = tmp(), idc = cli.main(['--begin', '--today', '2026-10-01', '--config', cfgOf(dc)]).match(/ATTEMPT ([0-9a-f]+)/)[1];
var refused = function (flags, msg) {
  var e = caught(function () { cli.main(['--end', '--attempt', idc, '--config', cfgOf(dc)].concat(flags), function () {}); });
  assert.strictEqual(e.message, msg);
  assert.strictEqual(S.load(dc).attempt.outcome, 'started', 'a refusal records nothing');
};
refused(['--brief', 'posted', '--details', 'posted', '--verified', 'yes', '--failed', 'verify', '--ref', 'abcd'], '--failed verify means the read-back failed, so --verified must be no. Nothing was recorded.');
refused(['--brief', 'posted', '--details', 'posted', '--verified', 'yes', '--failed', 'post', '--ref', 'abcd'], '--failed post means a post did not land, but --brief and --details are both posted and verified. Nothing was recorded.');
refused(['--brief', 'posted', '--details', 'rejected', '--verified', 'yes', '--failed', 'verify', '--ref', 'abcd'], '--failed verify means the read-back failed, so --verified must be no. Nothing was recorded.');
assert.ok(/^OPEN LOOPS NOTES/.test(cli.main(['--end', '--attempt', idc, '--config', cfgOf(dc), '--brief', 'posted', '--details', 'rejected', '--verified', 'no', '--failed', 'post'], function () {})), 'a post that half landed is still fine');
var dv = tmp(), idv = cli.main(['--begin', '--today', '2026-10-01', '--config', cfgOf(dv)]).match(/ATTEMPT ([0-9a-f]+)/)[1];
assert.ok(/^OPEN LOOPS NOTES/.test(cli.main(['--end', '--attempt', idv, '--config', cfgOf(dv), '--brief', 'posted', '--details', 'posted', '--verified', 'no', '--failed', 'verify', '--ref', 'abcd'], function () {})), 'and so is a read-back that failed');

console.log('final fixes: OK');
