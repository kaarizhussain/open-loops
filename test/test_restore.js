/* Putting a rejected item back (src/restore.js, tools/corrections.js).
 *
 * The one that matters: reject -> restore -> reject again -> same-day re-run. A same-day re-run rolls the ledger back to before the day's first
 * run, so it undoes a restore and re-reads the old reply it undid. The later rejection has to stay in force, and replaying the older restore must
 * not clear it.
 *
 * Time is fixed and in UTC. 2026-10-01 is a Thursday.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');
var { main } = require('../slack-run.js');
var corr = require('../tools/corrections.js');
var R = require('../src/restore.js');
var L = require('../src/ledger.js');
var S = require('../src/status.js');
var { fileStore } = require('../src/store.js');

var NL = String.fromCharCode(10), ME = 'alex@example.com', ROOT = path.join(__dirname, '..');
var ts = function (mo, d, h, mi) { return (Date.UTC(2026, mo - 1, d, h, mi || 0) / 1000).toFixed(6); };
var banner = function (t, body) { return '=== Message from Lena Borg <lena@vf.example> (U0EXAMPLE002) at ' + t + ' UTC ===' + NL + 'Message TS: ' + t + NL + body; };
var fenced = function (t, digestText) { return banner(t, '```' + NL + digestText + NL + '```'); };
/* `--now` is local time; this is the local reading of a UTC instant, so the tests do not depend on the machine's zone. */
var localNow = function (mo, d, h, mi) {
  var x = new Date(Date.UTC(2026, mo - 1, d, h, mi || 0)), p = function (n) { return (n < 10 ? '0' : '') + n; };
  return x.getFullYear() + '-' + p(x.getMonth() + 1) + '-' + p(x.getDate()) + 'T' + p(x.getHours()) + ':' + p(x.getMinutes());
};

var world = function (cfgExtra, words) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-restore-')), cfg = path.join(dir, 'openloops.config.json'), ledger = path.join(dir, 'ledger.json'), n = 0;
  fs.writeFileSync(cfg, JSON.stringify(Object.assign({ you: ME, selfDm: 'U0EXAMPLE001', tzOffset: 0, spotCheck: 0, ledger: ledger, channels: { include: ['#ops'] } }, cfgExtra || {})));
  var chat = (words || ['alpha', 'bravo', 'charlie']).map(function (w, i) { return banner(ts(9, words ? 28 : 25 + i, words ? 1 + i : 10), 'Please send the ' + w + ' report Thursday Oct 1.'); }).join(NL);
  var w = {
    dir: dir, cfg: cfg, ledger: ledger,
    run: function (today, extra, flags) {
      var p = path.join(dir, 'in' + (n++) + '.json');
      fs.writeFileSync(p, JSON.stringify(Object.assign({ today: today, conversations: [{ channel: '#ops', members: [], text: chat, complete: true }], dm: { channel: 'D0', text: '' } }, extra || {})));
      return main([p, '--config', cfg].concat(flags || []));
    },
    data: function () { return JSON.parse(fs.readFileSync(ledger, 'utf8')); },
    row: function (word) { return w.data().rows.filter(function (r) { return new RegExp(word).test(r[L.COL.what]); })[0]; },
    verdict: function (word) { return w.row(word)[L.COL.verdict]; },
    corr: function (args) { return corr.main(args.concat(['--config', cfg])); },
    requests: function () { return JSON.parse(fs.readFileSync(path.join(dir, 'restores.json'), 'utf8')).requests; }
  };
  return w;
};
var itemNo = function (text, word) { var m = text.split(NL).map(function (l) { return l.match(new RegExp('^ ?(\\d+) {2}.*' + word)); }).filter(Boolean)[0]; return m ? m[1] : null; };
var refOf = function (text) { return text.match(/· ref ([0-9a-f]{4})/)[1]; };
var dmOf = function (digests) { return { channel: 'D0', text: digests.map(function (d) { return fenced(d[0], d[1]); }).join(NL) }; };

/* ============================== 1. reject -> restore -> reject again -> same-day re-run ============================== */
var w = world();
var dg1 = w.run('2026-09-30'), t1 = ts(9, 30, 22), n1 = itemNo(dg1, 'alpha');
assert.ok(n1, 'alpha is in the first digest: ' + dg1);
var R1 = banner(ts(10, 1, 9), n1);                                         // reject alpha, under digest 1
var threadOf = function (root, digestText, replies) { return { root: root, text: fenced(root, digestText) + NL + replies.join(NL) }; };

// Run A (Oct 1): the rejection is applied. Alpha is hidden, and has a reference.
var tA = ts(10, 1, 18);
var dgA = w.run('2026-10-01', { dm: dmOf([[t1, dg1]]), dmThread: [threadOf(t1, dg1, [R1])] });
assert.strictEqual(w.verdict('alpha'), 'x', 'rejected');
assert.strictEqual(itemNo(dgA, 'alpha'), null, 'and no longer listed');
var list1 = w.corr(['--list']);
var ref = (list1.match(/^ {2}([0-9a-f]{8}) {2}rejection recorded Oct 1 · first seen Sep 30/m) || [])[1];
assert.ok(ref, 'the list names it by a reference, with when it was rejected and how old it is: ' + list1);
assert.ok(/"Please send the alpha report Thursday Oct 1\."/.test(list1), 'and shows the sentence');

// Restore it, at 19:00. Until the digest runs it is only a request.
var asked = w.corr(['--restore', ref, '--now', localNow(10, 1, 19)]);
assert.ok(new RegExp('^Restore requested for ' + ref + ' \\(request [0-9a-f]{8}\\)\\. It is queued: your next digest will say whether it came back\\.$').test(asked), asked);
assert.ok(!/restored|came back\.$/i.test(asked.replace(/^Restore requested.*queued: your next digest will say whether it came back\./, '')), 'and promises nothing else');
assert.strictEqual(w.verdict('alpha'), 'x', 'a request changes nothing: only the digest writes the ledger');
assert.ok(/pending: waiting for the next digest to process it/.test(w.corr(['--list'])), 'it is listed as pending');

// Run B (same day, 19:30): the ledger is rolled back, the old reply is read again, and the restore applies.
var tB = ts(10, 1, 19, 30);
var dmAB = function (digests) { return dmOf([[t1, dg1], [tA, dgA]].concat(digests || [])); };
var dgB = w.run('2026-10-01', { dm: dmAB(), dmThread: [threadOf(t1, dg1, [R1])] });
assert.strictEqual(w.verdict('alpha'), '', 'restored');
assert.strictEqual(w.row('alpha')[L.COL.first_seen], '2026-09-30', 'with its original age: the row is the one that was there, not a new one');
assert.ok(itemNo(dgB, 'alpha'), 'and listed again');
assert.ok(new RegExp('^Restored 1 item you had rejected — it is back as item ' + itemNo(dgB, 'alpha') + ' and keeps its original age \\(first seen Sep 30\\)\\.$', 'm').test(dgB), dgB.split(NL).slice(0, 8).join(' / '));
assert.ok(!/NOT APPLIED/.test(dgB), 'the old reply, unchanged, is simply old: it is not reported');
assert.ok(/applied Oct 1/.test(w.corr(['--list'])), 'and the list says it was applied');

// The reader rejects it again, under digest B, at 20:00.
var R2 = banner(ts(10, 1, 20), itemNo(dgB, 'alpha'));
var threads = [threadOf(t1, dg1, [R1]), threadOf(tB, dgB, [R2])];
var dmAll = function () { return dmAB([[tB, dgB]]); };

// Run C (same day): rolled back again. The restore is replayed — and the later rejection stays in force.
var dgC = w.run('2026-10-01', { dm: dmAll(), dmThread: threads });
assert.strictEqual(w.verdict('alpha'), 'x', 'the later rejection is in force');
assert.strictEqual(itemNo(dgC, 'alpha'), null, 'alpha is not listed');
assert.ok(/^You restored an item and then rejected it again, so it stays hidden\.$/m.test(dgC) || /Restored earlier — the digest that said so may not have reached you\. You restored an item and then rejected it again, so it stays hidden\./.test(dgC), dgC.split(NL).slice(0, 8).join(' / '));
assert.ok(/applied Oct 1, then you rejected it again, so it stays hidden/.test(w.corr(['--list'])), 'and the list says so');
// Again, and again: a re-run is a re-run.
var dgD = w.run('2026-10-01', { dm: dmAll(), dmThread: threads });
assert.strictEqual(w.verdict('alpha'), 'x', 'a further same-day re-run does not clear it either');
assert.strictEqual(itemNo(dgD, 'alpha'), null);
// The next day, with everything still in the DM and the request still in restores.json: the older request is not replayed.
assert.ok(w.requests().length === 1, 'the request is still in the file');
var dgE = w.run('2026-10-02', { dm: dmOf([[t1, dg1], [tA, dgA], [tB, dgB], [ts(10, 1, 21), dgC]]), dmThread: threads });
assert.strictEqual(w.verdict('alpha'), 'x', 'the next day it is still rejected: an older restore request is not replayed');
assert.strictEqual(itemNo(dgE, 'alpha'), null);
assert.ok(!/NOT APPLIED/.test(dgE), 'and nothing is reported');
var logAfter = w.data().restoreLog;
assert.strictEqual(Object.keys(logAfter).length, 1, 'one request, one entry');
assert.strictEqual(logAfter[w.requests()[0].id].state, 'applied');
assert.strictEqual(logAfter[w.requests()[0].id].superseded, true, 'recorded as applied and then superseded by the later rejection');

/* ---- a world with alpha rejected on Oct 1 (run A) and a restore requested at 19:00; `upto` says how far to take it */
var rejected = function (cfgExtra) {
  var x = world(cfgExtra);
  x.dg1 = x.run('2026-09-30'); x.t1 = ts(9, 30, 22); x.n1 = itemNo(x.dg1, 'alpha');
  x.R1text = x.n1;
  x.R1 = banner(ts(10, 1, 9), x.R1text);
  x.tA = ts(10, 1, 18);
  x.dgA = x.run('2026-10-01', { dm: dmOf([[x.t1, x.dg1]]), dmThread: [threadOf(x.t1, x.dg1, [x.R1])] });
  var st = x.data();
  x.key = st.refs[refOf(x.dg1)].keys[+x.n1 - 1];
  x.ref = Object.keys(st.restoreRefs).filter(function (r) { return st.restoreRefs[r].key === x.key; })[0];
  x.ask = function (args) { return x.corr(args.concat(['--now', localNow(10, 1, 19)])); };
  x.runB = function (thread) { return x.run('2026-10-01', { dm: dmOf([[x.t1, x.dg1], [x.tA, x.dgA]]), dmThread: thread || [threadOf(x.t1, x.dg1, [x.R1])] }); };
  x.rowByKey = function () { return x.data().rows.filter(function (r) { return r[L.COL.key] === x.key; })[0]; };
  return x;
};

/* ============================== 2. edited replies, and replies not known to be unchanged ============================== */
var e = rejected();
e.ask(['--restore', e.ref]);
var edited = banner(ts(10, 1, 9), e.R1text + NL + 'sorry, typo');          // the old reply, edited since it was read
var dgEd = e.runB([threadOf(e.t1, e.dg1, [edited])]);
assert.strictEqual(e.rowByKey()[L.COL.verdict], '', 'an edited reply that predates the restore does not reject the item again');
assert.ok(dgEd.indexOf('NOT APPLIED — an edited reply refers to an item you restored: "' + e.R1text + '". Send it again as a new reply if you want it rejected.') > -1, dgEd.split(NL).slice(0, 8).join(' / '));
// Reported again by a same-day re-run: the warning is not lost with the rollback.
var dgEd2 = e.runB([threadOf(e.t1, e.dg1, [edited])]);
assert.ok(/NOT APPLIED — an edited reply refers to an item you restored/.test(dgEd2), 'a re-run reports it again');
assert.strictEqual(e.rowByKey()[L.COL.verdict], '');

// Not known to be unchanged (the ledger has no record of what it said): reported as possibly edited, and not applied.
var u = rejected();
var ledgerU = u.data(); ledgerU.replyHashes = {}; fs.writeFileSync(u.ledger, JSON.stringify(ledgerU));
u.ask(['--restore', u.ref]);
var dgUn = u.runB();
assert.strictEqual(u.rowByKey()[L.COL.verdict], '', 'a reply from before the restore, not known to be unchanged, is not applied');
assert.ok(dgUn.indexOf('NOT APPLIED — a reply from before you restored an item refers to it, and it may have been edited: "' + u.R1text + '". Send it again as a new reply if you want it rejected.') > -1, dgUn.split(NL).slice(0, 8).join(' / '));
// A new reply, typed after the restore, is a new reply and applies.
var u2 = rejected();
u2.ask(['--restore', u2.ref]);
var dgNew = u2.runB();
var newReply = banner(ts(10, 1, 20), itemNo(dgNew, 'alpha'));
u2.run('2026-10-01', { dm: dmOf([[u2.t1, u2.dg1], [u2.tA, u2.dgA], [ts(10, 1, 19, 30), dgNew]]), dmThread: [threadOf(u2.t1, u2.dg1, [u2.R1]), threadOf(ts(10, 1, 19, 30), dgNew, [newReply])] });
assert.strictEqual(u2.rowByKey()[L.COL.verdict], 'x', 'a reply typed after the request rejects it again');

/* ============================== 3. a reference survives its key being migrated ============================== */
var m = rejected();
var st0 = fileStore(m.ledger);
var K2 = m.key + '|migrated';
st0.migrateKeys((function () { var o = {}; o[m.key] = K2; return o; })());
st0.writeLedger(st0.readLedger().map(function (r) { if (r[L.COL.key] === m.key) r[L.COL.key] = K2; return r; }));
var after = m.data();
assert.strictEqual(after.restoreRefs[m.ref].key, K2, 'the reference now names the migrated key');
assert.ok(after.rows.some(function (r) { return r[L.COL.key] === K2 && r[L.COL.verdict] === 'x'; }));
// A request made against the OLD reference still finds the item, and clears the migrated row.
var st1 = fileStore(m.ledger), rows1 = st1.readLedger();
var ctx = R.begin({ store: st1, requests: [{ id: 'aaaa1111', ref: m.ref, requestedAt: '2026-10-01T19:00:00.000Z' }], today: '2026-10-01' });
assert.strictEqual(ctx.active.length, 1, 'the reference resolves');
assert.strictEqual(ctx.active[0].key, K2);
R.settle({ store: st1, rows: rows1, ctx: ctx, replies: { rejectedAt: {}, fencedKeys: {} }, today: '2026-10-01' });
assert.strictEqual(rows1.filter(function (r) { return r[L.COL.key] === K2; })[0][L.COL.verdict], '', 'and the migrated row is the one cleared');
assert.strictEqual(st1.restoreState().log['aaaa1111'].key, K2);
// A fence and a log entry made before a migration follow the key too.
var st2 = fileStore(m.ledger);
st2.restoreState().log['bbbb2222'] = { state: 'applied', key: K2, requestedAt: '2026-10-01T19:00:00.000Z', on: '2026-10-01' };
st2.migrateKeys((function () { var o = {}; o[K2] = K2 + '2'; return o; })());
assert.strictEqual(st2.restoreState().log['bbbb2222'].key, K2 + '2');
assert.strictEqual(st2.restoreState().refs[m.ref].key, K2 + '2');

/* ============================== 4. the row is gone: it is not invented, and nothing is promised ============================== */
var g = rejected();
var ledgerG = g.data(); ledgerG.rows = ledgerG.rows.filter(function (r) { return r[L.COL.key] !== g.key; }); fs.writeFileSync(g.ledger, JSON.stringify(ledgerG));   // pruned
g.ask(['--restore', g.ref]);
var dgGone = g.run('2026-10-02');    // a later day: a same-day re-run would roll the pruned row back
assert.ok(dgGone.indexOf('NOT RESTORED — ' + g.ref + ' is no longer tracked, so its original age cannot be recovered. If it is still outstanding it may be detected again as new, with a new age.') > -1, dgGone.split(NL).slice(0, 8).join(' / '));
assert.ok(!/it will appear|will be listed again|will come back/i.test(dgGone), 'it does not say it will appear');
var regrown = g.rowByKey();
assert.ok(!regrown || regrown[L.COL.first_seen] === '2026-10-02', 'if it was found again it is a new row with a new age, not the old one');
assert.ok(/refused: no longer tracked/.test(g.corr(['--list'])));
assert.strictEqual(g.data().restoreLog[g.requests()[0].id].state, 'refused');

/* ============================== 5. storeText: false — no sentences, and restoring by a digest's item number ============================== */
var t = rejected({ storeText: false });
var listT = t.corr(['--list']);
assert.ok(new RegExp('^ {2}' + t.ref + ' {2}rejection recorded Oct 1 · first seen Sep 30 · owed_by_us \\(the ledger keeps no sentences\\)$', 'm').test(listT) || /\(the ledger keeps no sentences\)/.test(listT), listT);
assert.ok(!/alpha/.test(listT) && t.data().rows.every(function (r) { return !r[L.COL.what]; }), 'no sentence is stored or shown');
var byItem = t.ask(['--restore-item', t.n1, '--digest', refOf(t.dg1)]);
assert.ok(/^Restore requested for [0-9a-f]{4}#\d+ \(request [0-9a-f]{8}\)\. It is queued: your next digest will say whether it came back\.$/.test(byItem) || /^Restore requested for /.test(byItem), byItem);
var req = t.requests()[0];
assert.deepStrictEqual(Object.keys(req).sort(), ['digest', 'id', 'requestedAt'], 'only the structured request is stored');
assert.deepStrictEqual(req.digest, { ref: refOf(t.dg1), n: +t.n1 });
var dgT = t.runB();
assert.strictEqual(t.rowByKey()[L.COL.verdict], '', 'restored by item number');
assert.ok(/^Restored 1 item you had rejected — it is back as item \d+ and keeps its original age \(first seen Sep 30\)\.$/m.test(dgT), dgT.split(NL).slice(0, 8).join(' / '));
assert.ok(t.data().rows.every(function (r) { return !r[L.COL.what]; }), 'and still no sentences');

/* ============================== 6. an acknowledgement is at-least-once, and ends when a digest that carried it is confirmed delivered ============================== */
var ackWorld = function () { var a = rejected(); a.ask(['--restore', a.ref]); a.dgB = a.runB(); a.refB = refOf(a.dgB); return a; };
var delivered = function (a, ref) { fs.writeFileSync(path.join(a.dir, 'status.json'), JSON.stringify({ delivered: { date: '2026-10-01', at: '2026-10-01T20:00:00.000Z', ref: ref } })); };
var ACK = /Restored 1 item you had rejected — it is back as item/, REPEAT = /Restored earlier — the digest that said so may not have reached you\. It is back as item \d+ and keeps its original age \(first seen Sep 30\)\./;
var a1 = ackWorld();
assert.ok(ACK.test(a1.dgB), 'said once, in the digest that applied it');
delivered(a1, a1.refB);
var a1next = a1.run('2026-10-02');
assert.ok(!ACK.test(a1next) && !REPEAT.test(a1next), 'that digest was confirmed delivered, so it is not said again');
var a2 = ackWorld();                        // no confirmation: the post may have succeeded before its confirmation failed, or may not have
var a2d2 = a2.run('2026-10-02');
assert.ok(REPEAT.test(a2d2), 'without confirmation it is carried again, as a repeat: ' + a2d2.split(NL).slice(0, 6).join(' / '));
assert.ok(!ACK.test(a2d2), 'and not as if it were news');
var a2d3 = a2.run('2026-10-03');
assert.ok(REPEAT.test(a2d3), 'and again');
// There is no cap: neither attempts nor repetitions are a confirmation. Seven unconfirmed digests in, it is still carried.
var carried = [];
['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08'].forEach(function (d) {
  var out = a2.run(d);
  assert.ok(REPEAT.test(out), d + ': still carried after ' + (carried.length + 3) + ' unconfirmed digests');
  carried.push(refOf(out));
});
assert.strictEqual(a2.rowByKey()[L.COL.verdict], '', 'repeating a note never applies a restore twice');
assert.strictEqual(a2.data().restoreLog[a2.requests()[0].id].acked, false, 'and it is not recorded as acknowledged');
// What ends it is confirmed delivery of a digest that carried it — not necessarily the latest one.
delivered(a2, carried[1]);
assert.ok(!REPEAT.test(a2.run('2026-10-09')), 'confirmed: an earlier carrier was the last delivered digest, so it stops');
assert.ok(!REPEAT.test(a2.run('2026-10-10')), 'and stays stopped');
assert.strictEqual(a2.data().restoreLog[a2.requests()[0].id].acked, true);
// A delivery that did not carry it confirms nothing.
var a5 = ackWorld();
a5.run('2026-10-02');
delivered(a5, 'ffff');
assert.ok(REPEAT.test(a5.run('2026-10-03')), 'a delivered digest that did not carry the note is not its confirmation');
// Confirmed after being carried twice: it ends there.
var a3 = ackWorld();
a3.run('2026-10-02');
delivered(a3, refOf(a3.run('2026-10-03')));
assert.ok(!REPEAT.test(a3.run('2026-10-04')), 'a later confirmation ends it');
// A same-day re-run after a delivered digest does not say it again either.
var a4 = ackWorld();
delivered(a4, a4.refB);
assert.ok(!ACK.test(a4.runB()), 'the digest it was said in was delivered: the re-run that replaces it does not repeat it');

/* ============================== 7. states, retries, and what is stored ============================== */
var s = rejected();
s.ask(['--restore', s.ref]);
var again = s.ask(['--restore', s.ref]);
assert.ok(/^Restore already requested for /.test(again), 'asking twice while one is waiting is the same request: ' + again);
assert.strictEqual(s.requests().length, 1);
assert.deepStrictEqual(Object.keys(s.requests()[0]).sort(), ['id', 'ref', 'requestedAt'], 'only an id, what it points at and when');
s.runB();
var applied = s.data().restoreLog[s.requests()[0].id];
assert.strictEqual(applied.state, 'applied');
s.runB(); s.runB();                         // retries of the same day's run
assert.strictEqual(Object.keys(s.data().restoreLog).length, 1, 'a retry decides nothing twice');
assert.strictEqual(s.rowByKey()[L.COL.verdict], '');
// Asking again for something already restored is refused, not applied again.
s.ask(['--restore', s.ref]);
var dgNr = s.run('2026-10-02');
assert.ok(dgNr.indexOf('NOT RESTORED — ' + s.ref + ' is not currently rejected, so there is nothing to restore.') > -1, dgNr.split(NL).slice(0, 8).join(' / '));
assert.strictEqual(s.data().restoreLog[s.requests()[0].id].state, 'applied', 'the first request is still applied: a later run does not decide it again');
// What cannot point at anything is refused when it is asked, and by the digest if it got into the file anyway.
assert.ok(/^NOT QUEUED — deadbeef is not a reference this ledger knows/.test(s.corr(['--restore', 'deadbeef'])), 'refused at the tool');
assert.ok(/^NOT QUEUED/.test(s.corr(['--restore-item', '40', '--digest', refOf(s.dg1)])), 'a number past the digest\'s list');
fs.writeFileSync(path.join(s.dir, 'restores.json'), JSON.stringify({ requests: s.requests().concat([{ id: 'cafe0001', ref: 'deadbeef', requestedAt: '2026-10-02T09:00:00.000Z' }]) }));
var dgUnknown = s.run('2026-10-03');
assert.ok(dgUnknown.indexOf('NOT RESTORED — deadbeef is not a reference this ledger knows. Ask for the list of rejected items and use a reference from it.') > -1, dgUnknown.split(NL).slice(0, 8).join(' / '));
// A prefix that is the start of two references is refused, not guessed.
var led = s.data(); led.restoreRefs['1234aaaa'] = { key: 'k-one', on: '2026-10-01' }; led.restoreRefs['1234bbbb'] = { key: 'k-two', on: '2026-10-01' }; fs.writeFileSync(s.ledger, JSON.stringify(led));
assert.ok(/^NOT QUEUED — 1234 is the start of more than one reference\. Use more characters\./.test(s.corr(['--restore', '1234'])));
fs.writeFileSync(path.join(s.dir, 'restores.json'), JSON.stringify({ requests: s.requests().concat([{ id: 'cafe0002', ref: '1234', requestedAt: '2026-10-03T09:00:00.000Z' }]) }));
assert.ok(s.run('2026-10-04').indexOf('NOT RESTORED — 1234 is the start of more than one reference. Use more characters.') > -1);
// A restores.json that cannot be read is left alone by the tool and ignored by the digest.
var dmg = rejected();
fs.writeFileSync(path.join(dmg.dir, 'restores.json'), '{ not json');
assert.throws(function () { dmg.ask(['--restore', dmg.ref]); }, /restores\.json could not be read, so nothing was queued\. The file was preserved\. Ask your assistant to inspect it before trying again\./);
assert.ok(!/remove|delete/i.test((function () { try { dmg.ask(['--restore', dmg.ref]); } catch (e) { return e.message; } })()), 'and it does not suggest deleting the queued requests');
assert.strictEqual(fs.readFileSync(path.join(dmg.dir, 'restores.json'), 'utf8'), '{ not json', 'the damaged file is untouched');
assert.doesNotThrow(function () { dmg.runB(); }, 'and the digest still runs');
assert.ok(/restores\.json could not be read/.test(dmg.corr(['--list'])));

/* ============================== 8. a midday check applies nothing and writes nothing ============================== */
var c = rejected({ alerts: { delivery: 'dm', consentedAt: '2026-09-29T20:00:00Z', times: ['12:00', '15:00'] } });
c.ask(['--restore', c.ref]);
assert.ok(/^Baseline recorded/.test(require('../tools/alerts.js').main(['--baseline', '--ref', refOf(c.dgA), '--config', c.cfg])));
var before = fs.readFileSync(c.ledger, 'utf8');
var checkOut = c.run('2026-10-01', { dm: dmOf([[c.t1, c.dg1]]), dmThread: [threadOf(c.t1, c.dg1, [c.R1])] }, ['--check', '--slot', '12:00', '--today', '2026-10-01', '--now', '2026-10-01T12:05']);
assert.strictEqual(fs.readFileSync(c.ledger, 'utf8'), before, 'a check never writes the ledger, with a restore waiting');
assert.ok(/^NO ALERT/.test(checkOut) && !/alpha/.test(checkOut), 'and the item is not alerted as if it were back: ' + checkOut.slice(0, 200));
assert.strictEqual(c.rowByKey()[L.COL.verdict], 'x', 'the request waits for the digest');

/* ============================== 9. what is said about the restored item follows what the digest actually shows ============================== */
var MANY = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango'.split(' ');
var restoreNumbered = function (pickN) {
  var x = world({}, MANY);
  x.dg1 = x.run('2026-09-30'); x.t1 = ts(9, 30, 22);
  x.dgA = x.run('2026-10-01', { dm: dmOf([[x.t1, x.dg1]]) }); x.tA = ts(10, 1, 18);          // today's list, before anything is rejected
  var keysA = x.data().refs[refOf(x.dgA)].keys, n = pickN(keysA.length), Rn = banner(ts(10, 1, 20), String(n));
  x.key = keysA[n - 1];
  var threadA = [threadOf(x.tA, x.dgA, [Rn])];
  x.dgB1 = x.run('2026-10-02', { dm: dmOf([[x.t1, x.dg1], [x.tA, x.dgA]]), dmThread: threadA }); x.tB1 = ts(10, 2, 10);   // the rejection is applied
  assert.strictEqual(x.data().rows.filter(function (r) { return r[L.COL.key] === x.key; })[0][L.COL.verdict], 'x', 'rejected item ' + n);
  var st = x.data(); x.ref = Object.keys(st.restoreRefs).filter(function (r) { return st.restoreRefs[r].key === x.key; })[0];
  x.corr(['--restore', x.ref, '--now', localNow(10, 2, 12)]);
  x.dgB = x.run('2026-10-02', { dm: dmOf([[x.t1, x.dg1], [x.tA, x.dgA], [x.tB1, x.dgB1]]), dmThread: threadA });          // a same-day re-run applies the restore
  x.nB = x.data().refs[refOf(x.dgB)].keys.indexOf(x.key) + 1;
  x.printed = function (text, k) { return new RegExp('^ ?' + k + ' {2}', 'm').test(text); };
  return x;
};
// The item ranks first: it is on the page, and the digest says where.
var shownR = restoreNumbered(function () { return 1; });
assert.ok(shownR.nB >= 1 && shownR.printed(shownR.dgB, shownR.nB), 'item ' + shownR.nB + ' is printed in the digest');
assert.ok(shownR.dgB.indexOf('Restored 1 item you had rejected — it is back as item ' + shownR.nB + ' and keeps its original age (first seen Sep 30).') > -1, shownR.dgB.split(NL).slice(0, 8).join(' / '));
// Shown only in the details (the head of its pile, but not in the brief): it counts as shown.
var SPLIT = require('../src/digest.js').SPLIT, detailsOnly = null;
for (var up = 1; up < MANY.length - 1 && !detailsOnly; up++) {
  var dw = restoreNumbered(function (len) { return Math.min(up, len); }), parts = dw.dgB.split(SPLIT);
  if (dw.nB >= 1 && !dw.printed(parts[0], dw.nB) && dw.printed(parts.slice(1).join(SPLIT), dw.nB)) detailsOnly = dw;
}
assert.ok(detailsOnly, 'some restored item is printed in the details and not in the brief');
assert.ok(detailsOnly.dgB.indexOf('it is back as item ' + detailsOnly.nB + ' and keeps its original age (first seen Sep 30).') > -1, 'an item shown in the details is shown: ' + detailsOnly.dgB.split(NL).slice(0, 6).join(' / '));
// The item ranks last of twenty: this digest holds it back, and does not say it is back as item N.
/* Where a restored item ranks depends on the day's ordering, so look for one that lands past the cap rather than assume it. */
var trimmed = null;
for (var back = 0; back < MANY.length - 1 && !trimmed; back++) {      // the last-ranked item of today's list, then the one before it, ...
  var tryWorld = restoreNumbered(function (len) { return len - back; });
  if (tryWorld.nB >= 13) trimmed = tryWorld;
}
assert.ok(trimmed, 'some item lands past the cap of twelve');
assert.ok(trimmed.nB >= 13, 'it ranks past the cap: ' + trimmed.nB);
assert.ok(!trimmed.printed(trimmed.dgB, trimmed.nB), 'and it is not printed in the digest');
assert.ok(trimmed.dgB.indexOf('Restore applied — it keeps its original age (first seen Sep 30), but it is not shown in this digest. It remains tracked.') > -1, trimmed.dgB.split(NL).slice(0, 8).join(' / '));
assert.ok(!/back as item/.test(trimmed.dgB), 'no "back as item" for an item the digest does not show');
assert.ok(!new RegExp('item ' + trimmed.nB + '\\b').test(trimmed.dgB.split(NL).filter(function (l) { return /Restore/.test(l); }).join(' ')), 'and no hidden item number is given');
assert.strictEqual(trimmed.data().rows.filter(function (r) { return r[L.COL.key] === trimmed.key; })[0][L.COL.verdict], '', 'it is restored all the same');
// Repeated, unconfirmed, it keeps the same shape.
var again2 = trimmed.run('2026-10-03');
assert.ok(again2.indexOf('Restored earlier — the digest that said so may not have reached you. It keeps its original age (first seen Sep 30), but it is not shown in this digest. It remains tracked.') > -1, again2.split(NL).slice(0, 8).join(' / '));

console.log('restore: OK');
