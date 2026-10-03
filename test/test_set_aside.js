/* A rejected record that is set aside (it could not be tied to one person) keeps the reference and the date it had, is shown in the restore list with the
 * reason, is not counted as restorable, and is refused when restore is asked for. Nothing is handed to a person unless identity is unambiguous.
 * And `status --show` reports every problem with the channel settings and still shows the rest of the status.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var cli = require('../tools/status.js');
var corr = require('../tools/corrections.js');
var L = require('../src/ledger.js');
var loops = require('../src/loops.js');
var { fileStore } = require('../src/store.js');
var { main } = require('../slack-run.js');

var NL = String.fromCharCode(10), ME = 'alex@example.com';
var tmp = function () { return fs.mkdtempSync(path.join(os.tmpdir(), 'ol-aside-')); };
var ts = function (mo, d, h, mi) { return (Date.UTC(2026, mo - 1, d, h, mi || 0) / 1000).toFixed(6); };
var banner = function (t, body) { return '=== Message from Lena Borg <lena@vf.example> (U0EXAMPLE002) at ' + t + ' UTC ===' + NL + 'Message TS: ' + t + NL + body; };
var fenced = function (t, d) { return banner(t, '```' + NL + d + NL + '```'); };
var localNow = function (mo, d, h, mi) {
  var x = new Date(Date.UTC(2026, mo - 1, d, h, mi || 0)), p = function (v) { return (v < 10 ? '0' : '') + v; };
  return x.getFullYear() + '-' + p(x.getMonth() + 1) + '-' + p(x.getDate()) + 'T' + p(x.getHours()) + ':' + p(x.getMinutes());
};
var ASIDE_WHY = 'was set aside because the item could not be tied to one person, so it cannot be restored. If it is still outstanding it may be detected again as new, with a new age.';

/* ============================== 1. identity set-aside (a rejection with nobody's name on it) ============================== */
var world = function () {
  var dir = tmp(), cfg = path.join(dir, 'openloops.config.json'), ledger = path.join(dir, 'ledger.json'), n = 0;
  fs.writeFileSync(cfg, JSON.stringify({ you: ME, selfDm: 'U0EXAMPLE001', tzOffset: 0, spotCheck: 0, ledger: ledger, channels: { include: ['#ops'] } }));
  var chat = ['alpha', 'bravo', 'charlie'].map(function (w, i) { return banner(ts(9, 25 + i, 10), 'Please send the ' + w + ' report Thursday Oct 1.'); }).join(NL);
  var w = {
    dir: dir, cfg: cfg, ledger: ledger,
    run: function (today, extra) { var p = path.join(dir, 'in' + (n++) + '.json'); fs.writeFileSync(p, JSON.stringify(Object.assign({ today: today, conversations: [{ channel: '#ops', members: [], text: chat, complete: true }], dm: { channel: 'D0', text: '' } }, extra || {}))); return main([p, '--config', cfg]); },
    data: function () { return JSON.parse(fs.readFileSync(ledger, 'utf8')); },
    save: function (d) { fs.writeFileSync(ledger, JSON.stringify(d)); },
    corr: function (a) { return corr.main(a.concat(['--config', cfg])); },
    req: function () { return path.join(dir, 'restores.json'); }
  };
  w.dg1 = w.run('2026-09-30'); w.t1 = ts(9, 30, 22);
  w.n1 = w.dg1.split(NL).map(function (l) { return l.match(/^ ?(\d+) {2}.*alpha/); }).filter(Boolean)[0][1];
  var R1 = banner(ts(10, 1, 9), w.n1);
  w.dgA = w.run('2026-10-01', { dm: { channel: 'D0', text: fenced(w.t1, w.dg1) }, dmThread: [{ root: w.t1, text: fenced(w.t1, w.dg1) + NL + R1 }] });
  var st = w.data(); w.key = st.refs[w.dg1.match(/· ref ([0-9a-f]{4})/)[1]].keys[+w.n1 - 1];
  w.ref = Object.keys(st.restoreRefs).filter(function (r) { return st.restoreRefs[r].key === w.key; })[0];
  w.digestRef = w.dg1.match(/· ref ([0-9a-f]{4})/)[1];
  return w;
};
var s = world();
assert.ok(s.ref, 'the rejected item has a reference');
// An old ledger's row: the rejection is on it, and nobody's name.
var led = s.data(); led.rows.forEach(function (r) { if (r[L.COL.key] === s.key) { r[L.COL.who] = ''; r[L.COL.who_id] = ''; } }); s.save(led);
var onBefore = s.data().restoreRefs[s.ref].on;
var first = s.run('2026-10-02');
var rows2 = s.data().rows, aside = rows2.filter(function (r) { return r[L.COL.key] === s.key + '|ambiguous'; })[0];
assert.ok(aside && aside[L.COL.verdict] === 'x', 'the record was set aside, with its rejection');
assert.strictEqual(s.data().restoreRefs[s.ref].key, s.key + '|ambiguous', 'its original reference follows it');
assert.strictEqual(s.data().restoreRefs[s.ref].on, onBefore, 'and keeps its date');
assert.strictEqual(Object.keys(s.data().restoreRefs).length, 1, 'and it is given no new reference');
var person = rows2.filter(function (r) { return r[L.COL.key] === s.key; })[0];
assert.ok(!person || (person[L.COL.verdict] === '' && person[L.COL.first_seen] === '2026-10-02'), 'nothing is handed to the person who appears: no verdict, and no age');
var list = s.corr(['--list']);
assert.ok(/^HIDDEN AS WRONG — 0$/m.test(list), 'it is not counted as restorable: ' + list);
assert.ok(new RegExp('^ {2}' + s.ref + ' {2}rejection recorded Oct 1 · first seen Sep 30 · .* — set aside: it could not be tied to one person, so it cannot be restored\\.$', 'm').test(list), 'but it is still listed, with its reference, its date and the reason: ' + list);
// Asking for it back is refused, where it is asked and where the digest reads it.
var asked = s.corr(['--restore', s.ref, '--now', localNow(10, 2, 19)]);
assert.strictEqual(asked, 'NOT QUEUED — ' + s.ref + ' was set aside because the item could not be tied to one person, so it cannot be restored. Nothing was queued.');
assert.ok(!fs.existsSync(s.req()), 'nothing was queued');
fs.writeFileSync(s.req(), JSON.stringify({ requests: [{ id: 'aaaa0001', ref: s.ref, requestedAt: '2026-10-02T19:00:00.000Z' }, { id: 'aaaa0002', digest: { ref: s.digestRef, n: +s.n1 }, requestedAt: '2026-10-02T19:01:00.000Z' }] }));
var next = s.run('2026-10-03');
assert.ok(next.split(NL).indexOf('NOT RESTORED — ' + s.ref + ' ' + ASIDE_WHY) > -1, next.split(NL).slice(0, 8).join(' / '));
assert.strictEqual(s.data().restoreLog.aaaa0001.reason, 'set_aside');
assert.strictEqual(s.data().restoreLog.aaaa0002.reason, 'set_aside', 'by item number too');
assert.ok(/refused: set aside, not restorable/.test(s.corr(['--list'])), 'the request list says so');
assert.ok(!/not currently rejected|no longer tracked/.test(next + s.corr(['--list'])), 'and not that it was not rejected, or not tracked');
assert.strictEqual(s.data().rows.filter(function (r) { return r[L.COL.key] === s.key + '|ambiguous'; })[0][L.COL.verdict], 'x', 'the record is left as it was');

// A same-day re-run: the rollback puts the reference back with the row, and the re-run sets the record aside again.
var s2 = world();
var led2 = s2.data(); led2.rows.forEach(function (r) { if (r[L.COL.key] === s2.key) { r[L.COL.who] = ''; r[L.COL.who_id] = ''; } }); s2.save(led2);
s2.run('2026-10-02');
['rerun 1', 'rerun 2'].forEach(function (label) {
  s2.run('2026-10-02');
  assert.strictEqual(s2.data().restoreRefs[s2.ref].key, s2.key + '|ambiguous', label + ': the reference is still on the set-aside record');
  assert.strictEqual(Object.keys(s2.data().restoreRefs).length, 1, label + ': no second reference');
  assert.strictEqual(s2.data().restoreRefs[s2.ref].on, onBefore, label + ': and the date is the same');
});

/* ============================== 2. a legacy row that is ambiguous across channels ============================== */
var ROOT_TS = '1790000000.000100', DECK = "I'll send the deck by Sep 30.";
var world2 = function () {
  var dir = tmp(), cfg = path.join(dir, 'openloops.config.json'), ledger = path.join(dir, 'ledger.json'), n = 0;
  fs.writeFileSync(cfg, JSON.stringify({ you: ME, selfDm: 'U0EXAMPLE001', tzOffset: 0, spotCheck: 0, ledger: ledger, channels: { include: ['#ops', '#dev'] } }));
  var w = {
    dir: dir, ledger: ledger,
    run: function (today, extra, chans) {
      chans = chans || ['#ops', '#dev'];
      var p = path.join(dir, 'in' + (n++) + '.json');
      var th = chans.map(function (c) { return { channel: c, root: ROOT_TS, members: [], complete: true, text: banner(ts(9, 29, 10), DECK) }; });
      fs.writeFileSync(p, JSON.stringify(Object.assign({ today: today, conversations: chans.map(function (c) { return { channel: c, members: [], text: '', complete: true }; }), threads: th, dm: { channel: 'D0', text: '' } }, extra || {})));
      return main([p, '--config', cfg]);
    },
    data: function () { return JSON.parse(fs.readFileSync(ledger, 'utf8')); },
    save: function (d) { fs.writeFileSync(ledger, JSON.stringify(d)); },
    corr: function (a) { return corr.main(a.concat(['--config', cfg])); }
  };
  w.d1 = w.run('2026-09-30', null, ['#ops']); w.t1 = ts(9, 30, 22);
  w.n1 = w.d1.split(NL).map(function (l) { return l.match(/^ ?(\d+) {2}.*deck/); }).filter(Boolean)[0][1];
  var R1 = banner(ts(10, 1, 9), w.n1);
  w.run('2026-10-01', { dm: { channel: 'D0', text: fenced(w.t1, w.d1) }, dmThread: [{ root: w.t1, text: fenced(w.t1, w.d1) + NL + R1 }] }, ['#ops']);
  var d = w.data(), K = d.rows[0][0], LK = loops.legacyKey(K);
  // as an older version wrote it
  d.rows[0][0] = LK;
  Object.keys(d.digests).forEach(function (k) { d.digests[k] = d.digests[k].map(function (x) { return x === K ? LK : x; }); });
  Object.keys(d.refs).forEach(function (k) { if (d.refs[k].keys) d.refs[k].keys = d.refs[k].keys.map(function (x) { return x === K ? LK : x; }); });
  Object.keys(d.restoreRefs).forEach(function (r) { if (d.restoreRefs[r].key === K) d.restoreRefs[r].key = LK; });
  w.save(d); w.LK = LK; w.ref = Object.keys(d.restoreRefs)[0];
  return w;
};
var amb = world2();
var onAmb = amb.data().restoreRefs[amb.ref].on;
amb.run('2026-10-02');                     // the same sentence under one root in two channels: the legacy key cannot say which
var ambKey = amb.LK + '|ambiguous';
assert.ok(amb.data().rows.some(function (r) { return r[L.COL.key] === ambKey && r[L.COL.verdict] === 'x'; }), 'the legacy record was set aside, with its rejection');
assert.strictEqual(amb.data().restoreRefs[amb.ref].key, ambKey, 'its reference follows');
assert.strictEqual(amb.data().restoreRefs[amb.ref].on, onAmb, 'with its date');
assert.strictEqual(Object.keys(amb.data().restoreRefs).length, 1);
var listAmb = amb.corr(['--list']);
assert.ok(/^HIDDEN AS WRONG — 0$/m.test(listAmb) && listAmb.indexOf(amb.ref + '  rejection recorded Oct 1') > -1 && /set aside: it could not be tied to one person/.test(listAmb), listAmb);
assert.ok(/^NOT QUEUED — .* was set aside/.test(amb.corr(['--restore', amb.ref, '--now', '2026-10-02T19:00'])));
amb.run('2026-10-02');                     // a same-day re-run
assert.strictEqual(amb.data().restoreRefs[amb.ref].key, ambKey, 'the same after a same-day re-run');

// A legacy row with a rejection and nobody's name is set aside too (not only an ambiguous one).
var own = world2();
var ledOwn = own.data(); ledOwn.rows.forEach(function (r) { r[L.COL.who] = ''; r[L.COL.who_id] = ''; }); own.save(ledOwn);
own.run('2026-10-02', null, ['#ops']);
assert.ok(own.data().rows.some(function (r) { return r[L.COL.key] === own.LK + '|ambiguous' && r[L.COL.verdict] === 'x'; }), 'the legacy record with no owner was set aside');
assert.strictEqual(own.data().restoreRefs[own.ref].key, own.LK + '|ambiguous', 'and its reference follows it too');

// A record rejected before references existed is set aside without being given one, and the list says how many.
var bare = world();
var ledBare = bare.data(); ledBare.restoreRefs = {}; ledBare.rows.forEach(function (r) { if (r[L.COL.key] === bare.key) { r[L.COL.who] = ''; r[L.COL.who_id] = ''; } }); bare.save(ledBare);
bare.run('2026-10-02');
assert.deepStrictEqual(Object.keys(bare.data().restoreRefs), [], 'no reference is made for a set-aside record');
var listBare = bare.corr(['--list']);
assert.ok(/^HIDDEN AS WRONG — 0$/m.test(listBare) && /^ {2}1 rejected record was set aside because it could not be tied to one person, and cannot be restored.$/m.test(listBare), listBare);

/* ============================== 3. the store: references follow a set-aside key, and a rollback puts it back ============================== */
var sd = tmp(), file = path.join(sd, 'l.json');
var st1 = fileStore(file);
st1.writeLedger([['A', '2026-09-01', '2026-09-30', '', 'owed_by_us', '', '', 'x']]);
st1.beginRun('2026-10-01');
st1.restoreState().refs.aaaa1111 = { key: 'A', on: '2026-09-30' };
st1.restoreState().log.bbbb2222 = { state: 'applied', key: 'A', requestedAt: '2026-10-01T10:00:00.000Z', on: '2026-10-01' };
st1.rememberRef('cccc', '2026-09-30', ['A']);
st1.followKeys({ A: 'A|ambiguous' });
assert.strictEqual(st1.restoreState().refs.aaaa1111.key, 'A|ambiguous');
assert.strictEqual(st1.restoreState().log.bbbb2222.key, 'A|ambiguous');
assert.deepStrictEqual(st1.recallRef('cccc').keys, ['A'], 'the digest memo is left as it was');
st1.writeLedger([['A|ambiguous', '2026-09-01', '2026-09-30', '', 'owed_by_us', '', '', 'x']]);
var st2 = fileStore(file); st2.beginRun('2026-10-01');
assert.strictEqual(st2.restoreState().refs.aaaa1111.key, 'A', 'a same-day rollback puts it back with the row');
assert.strictEqual(st2.restoreState().log.bbbb2222.key, 'A');

/* ============================== 4. status --show with channel settings that cannot be read ============================== */
var show = function (cfgObj, raw) {
  var d = tmp(), c = path.join(d, 'c.json');
  fs.writeFileSync(c, raw != null ? raw : JSON.stringify(Object.assign({ you: 'a@b.co', selfDm: 'U1' }, cfgObj)));
  return cli.main(['--show', '--read-only', '--config', c]);
};
var REST = [/Last delivered digest/, /Last attempt/, /Next run/, /Midday alerts off · Diagnostic reports off/, /It only runs while the app is open/];
var restShown = function (out, label) { REST.forEach(function (re) { assert.ok(re.test(out), label + ': the rest of the status is still shown (' + re + '): ' + out); }); };
var o1 = show({ channels: { include: 'x', exclude: 5 } });
restShown(o1, 'include and exclude');
assert.ok(/Tracking {16}the channel settings in your config cannot be read: "channels"\.include must be a list of channel names, got "x"\.\n {24}"channels"\.exclude must be a list of channel names, got 5\.\n/.test(o1), 'every problem is shown: ' + o1);
assert.ok(/Direct messages {9}your own DM \(the digest and your replies\)\n/.test(o1), 'and the line about direct messages claims nothing it cannot know');
assert.ok(!/Not tracking/.test(o1) && !/no include list is set/.test(o1), 'and it does not describe settings it could not read');
var o2 = show({ channels: 'x' });
restShown(o2, 'channels a string');
assert.ok(o2.indexOf('the channel settings in your config cannot be read: "channels" must be an object like {"exclude": ["#name"]}, got "x".') > -1, o2);
restShown(show({ channels: ['a'] }), 'channels an array');
assert.ok(show({ channels: ['a'] }).indexOf('got ["a"].') > -1);
restShown(show({ channels: 5 }), 'channels a number');
restShown(show({ channels: null }), 'channels null');
var o3 = show({ include: ['#a'], channels: { include: [' #b'], typo: [] } });
restShown(o3, 'several different problems');
['"channels.include" entry " #b" has leading or trailing spaces.', '"channels" has an unknown key "typo" — only include, exclude and only do anything.', '"include" at the top level of the config does nothing — it belongs inside "channels": {"include": [...]}.'].forEach(function (p) {
  assert.ok(o3.indexOf(p) > -1, 'problem shown: ' + p + '\n' + o3);
});
assert.ok(show({ channels: { include: 'x' } }).indexOf('"channels".include must be a list of channel names, got "x".') > -1);
// Settings that can be read are shown as ever.
var ok = show({ channels: { include: ['#ops', 'DM with Lena H'], exclude: ['#social'] } });
assert.ok(/Tracking {16}#ops\n/.test(ok) && /Not tracking {12}#social \(excluded\)/.test(ok) && /also DM with Lena H \(named in your config\)/.test(ok), ok);
assert.ok(!/cannot be read/.test(ok));
assert.ok(/every channel it is handed/.test(show({})), 'and no include list is still said so');
// A config that is not an object is refused by the same loader as the run; the view names it and still shows the history (test_status_bad_config.js).
assert.ok(/the configuration cannot be read: the config file must hold a JSON object, got null\. Fix it/.test(show(null, 'null')));

console.log('set aside and status: OK');
