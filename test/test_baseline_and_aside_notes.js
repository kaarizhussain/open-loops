/* 1. A refused baseline says what the midday checks will do, from the baseline that is actually there, and the checks do that.
 * 2. A restore whose record was set aside says only what the run can prove: that it was set aside, its original first-seen date, and which listed items carry the same
 *    commitment. It never says the age or a verdict moved, and on a later run it says "Restored earlier", not "Restore applied".
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');
var A = require('../src/alerts.js');
var L = require('../src/ledger.js');
var corr = require('../tools/corrections.js');
var { main } = require('../slack-run.js');

var ROOT = path.join(__dirname, '..'), NL = String.fromCharCode(10), ME = 'alex@example.com';
var tmp = function () { return fs.mkdtempSync(path.join(os.tmpdir(), 'ol-baseline-')); };
var ts = function (mo, d, h, mi) { return (Date.UTC(2026, mo - 1, d, h, mi || 0) / 1000).toFixed(6); };
var who = { lena: ['Lena Borg', 'lena@vf.example', 'U0EXAMPLE002'], sam: ['Sam Okafor', 'sam@acme.example', 'U0EXAMPLE003'] };
var banner = function (t, body, p) { p = p || 'lena'; return '=== Message from ' + who[p][0] + ' <' + who[p][1] + '> (' + who[p][2] + ') at ' + t + ' UTC ===' + NL + 'Message TS: ' + t + NL + body; };
var fenced = function (t, d) { return banner(t, '```' + NL + d + NL + '```'); };
var node = function (script, args) { return cp.spawnSync(process.execPath, [path.join(ROOT, script)].concat(args), { encoding: 'utf8', cwd: ROOT }); };

/* ============================== 1. the baseline refusal, and what the checks then do ============================== */
var dir = tmp(), cfg = path.join(dir, 'c.json'), ledger = path.join(dir, 'ledger.json'), n = 0;
fs.writeFileSync(cfg, JSON.stringify({ you: ME, selfDm: 'U0EXAMPLE001', tzOffset: 0, spotCheck: 0, ledger: ledger, channels: { include: ['#ops'] },
  alerts: { delivery: 'dm', consentedAt: '2026-09-29T20:00:00Z', times: ['12:00', '15:00'] } }));
var input = function (today) {
  var p = path.join(dir, 'in' + (n++) + '.json');
  fs.writeFileSync(p, JSON.stringify({ today: today, conversations: [{ channel: '#ops', members: [], text: banner(ts(9, 28, 9), "I'll send the deck Thursday Oct 1."), complete: true }], dm: { channel: 'D0', text: '' } }));
  return p;
};
var digest = main([input('2026-09-30'), '--config', cfg]);
var ref = digest.match(/· ref ([0-9a-f]{4})/)[1];
var baseFile = A.baselineFile(dir);
var check = function () { return main([input('2026-10-01'), '--config', cfg, '--check', '--slot', '12:00', '--today', '2026-10-01', '--now', '2026-10-01T12:05']); };
var alerts = function (args) { return node('tools/alerts.js', args.concat(['--config', cfg])); };

// No baseline yet: the refusal says so, exits 1, and the check skips.
assert.ok(!fs.existsSync(baseFile));
var none = alerts(['--baseline', '--ref', 'ffff']);
assert.strictEqual(none.status, 1);
assert.strictEqual(none.stdout.trim(), 'Nothing staged for that ref: no baseline was written, and there is no usable earlier baseline. Midday checks will skip until a digest writes one.');
assert.ok(/^SKIP — no digest baseline yet/.test(check()), 'and the midday check does skip');
// A good promotion: exit 0, and the checks run.
var promoted = alerts(['--baseline', '--ref', ref]);
assert.strictEqual(promoted.status, 0, promoted.stderr); assert.ok(/^Baseline recorded for the digest of 2026-09-30\./.test(promoted.stdout));
var ran = check();
assert.ok(!/^SKIP/.test(ran), 'with a usable baseline the check runs: ' + ran.split(NL)[0]);
// Refused again, with a usable earlier baseline: it names it, and the checks still run against it.
var older = alerts(['--baseline', '--ref', 'ffff']);
assert.strictEqual(older.status, 1);
assert.strictEqual(older.stdout.trim(), 'Nothing staged for that ref: no baseline was written. Midday checks will compare against the earlier baseline, from the digest of 2026-09-30.');
assert.ok(!/^SKIP/.test(check()), 'and they do');
// The baseline file cannot be read: the refusal does not claim an earlier baseline, and the checks skip.
var good = fs.readFileSync(baseFile, 'utf8');
[['not JSON', '{ not json'], ['JSON of the wrong shape', '{"version": 5}'], ['empty', '']].forEach(function (c) {
  fs.writeFileSync(baseFile, c[1]);
  var r = alerts(['--baseline', '--ref', 'ffff']);
  assert.strictEqual(r.status, 1, c[0]);
  assert.strictEqual(r.stdout.trim(), 'Nothing staged for that ref: no baseline was written, and the earlier baseline could not be read. Midday checks will skip until a digest writes one.', c[0]);
  assert.ok(!/earlier baseline, from the digest/.test(r.stdout), c[0] + ': it does not claim an earlier baseline exists');
  assert.ok(/^SKIP — no digest baseline yet/.test(check()), c[0] + ': and the midday check skips');
  assert.strictEqual(fs.readFileSync(baseFile, 'utf8'), c[1], c[0] + ': the file was not touched');
});
fs.writeFileSync(baseFile, good);
// A refusal writes nothing and changes nothing the checks read.
var before = fs.readFileSync(baseFile, 'utf8'), ledgerBefore = fs.readFileSync(ledger, 'utf8');
alerts(['--baseline', '--ref', 'ffff']);
assert.strictEqual(fs.readFileSync(baseFile, 'utf8'), before); assert.strictEqual(fs.readFileSync(ledger, 'utf8'), ledgerBefore);
var skill = fs.readFileSync(path.join(ROOT, 'skills', 'open-loops', 'SKILL.md'), 'utf8').split(String.fromCharCode(13)).join('').replace(/\s+/g, ' ');
assert.ok(skill.indexOf('If it refuses (exit 1), post what it printed under the digest, as the thread message below (its first line `OPEN LOOPS NOTES — for <YYYY-MM-DD>`, then the printed line), and do not try again with another reference') > -1, 'SKILL.md: under the standard header, once');

/* ============================== 2. a restore whose record was set aside ============================== */
var world = function (fillerCount) {
  var d = tmp(), c = path.join(d, 'openloops.config.json'), led = path.join(d, 'ledger.json'), k = 0;
  fs.writeFileSync(c, JSON.stringify({ you: ME, selfDm: 'U0EXAMPLE001', tzOffset: 0, spotCheck: 0, ledger: led, channels: { include: ['#ops'] } }));
  var w = {
    dir: d, ledger: led,
    run: function (today, people, extra) {
      var filler = []; for (var q = 0; q < (fillerCount || 0); q++) filler.push(banner(ts(9, 29, 1 + q), "I'll send the filler-" + q + ' report by Sep 30.', 'lena'));
      var chatText = people.map(function (p, i) { return banner(ts(9, 20, 10 + i), "I'll send the alpha report by Sep 21.", p); }).concat(filler).join(NL);
      var f = path.join(d, 'in' + (k++) + '.json');
      fs.writeFileSync(f, JSON.stringify(Object.assign({ today: today, conversations: [{ channel: '#ops', members: [], text: chatText, complete: true }], dm: { channel: 'D0', text: '' } }, extra || {})));
      return main([f, '--config', c]);
    },
    data: function () { return JSON.parse(fs.readFileSync(led, 'utf8')); },
    save: function (o) { fs.writeFileSync(led, JSON.stringify(o)); },
    corr: function (a) { return corr.main(a.concat(['--config', c])); }
  };
  w.dg1 = w.run('2026-09-30', ['lena']); w.t1 = ts(9, 30, 22);
  // its number in that digest, from the ledger's own memo (in a crowded digest it may not be printed)
  var first = w.data(), alphaRow = first.rows.filter(function (r) { return /alpha/.test(r[L.COL.what]); })[0];
  w.n1 = String(first.refs[w.dg1.match(/· ref ([0-9a-f]{4})/)[1]].keys.indexOf(alphaRow[L.COL.key]) + 1);
  var R1 = banner(ts(10, 1, 9), w.n1);
  w.run('2026-10-01', ['lena'], { dm: { channel: 'D0', text: fenced(w.t1, w.dg1) }, dmThread: [{ root: w.t1, text: fenced(w.t1, w.dg1) + NL + R1 }] });
  var st = w.data(); w.key = st.refs[w.dg1.match(/· ref ([0-9a-f]{4})/)[1]].keys[+w.n1 - 1];
  w.ref = Object.keys(st.restoreRefs).filter(function (r) { return st.restoreRefs[r].key === w.key; })[0];
  // the record as an older ledger had it: a rejection with nobody's name on it
  var o = w.data(); o.rows.forEach(function (r) { if (r[L.COL.key] === w.key) { r[L.COL.who] = ''; r[L.COL.who_id] = ''; } }); w.save(o);
  return w;
};
var notesOf = function (text) { return text.split(NL).filter(function (l) { return /^(Restore applied|Restored earlier|Restored 1 item|NOT RESTORED)/.test(l); }); };
var itemsFor = function (text, who) { return text.split(NL).map(function (l) { var m = l.match(new RegExp('^ ?(\\d+) {2}.*Chase ' + who + ' ')); return m ? m[1] : null; }).filter(Boolean); };

var w = world();
var asked = w.corr(['--restore', w.ref, '--now', '2026-10-02T09:00']);
assert.ok(/^Restore requested/.test(asked), asked);
// The restore applies, and then two people appear: the record cannot be tied to one of them.
var first = w.run('2026-10-02', ['lena', 'sam']);
var lena = itemsFor(first, 'Lena'), sam = itemsFor(first, 'Sam');
assert.ok(lena.length === 1 && sam.length === 1, 'both people are listed: ' + first);
var nums = [lena[0], sam[0]].sort().join(' and ');
var line1 = notesOf(first);
assert.strictEqual(line1.length, 1, 'one note: ' + line1.join(' / '));
assert.strictEqual(line1[0], 'Restore applied to its record (first seen Sep 30), but the record could not be tied to one person, so it was set aside. The same commitment is listed below as matching items ' + nums + '.');
assert.ok(!/new item|age was not|age and|transferred|passed on|keeps its original age|back as item/.test(line1[0]), 'it makes no claim that age or a verdict moved, and does not call them new');
assert.ok(w.data().rows.some(function (r) { return /[|]ambiguous$/.test(r[L.COL.key]); }), 'the record is set aside');
// A later run, the note unconfirmed: "Restored earlier", with the same first-seen date.
var second = w.run('2026-10-03', ['lena', 'sam']);
var nums2 = [itemsFor(second, 'Lena')[0], itemsFor(second, 'Sam')[0]].sort().join(' and ');
var line2 = notesOf(second);
assert.strictEqual(line2.length, 1);
assert.strictEqual(line2[0], 'Restored earlier — the digest that said so may not have reached you. The record (first seen Sep 30) could not be tied to one person and was set aside. The same commitment is listed below as matching items ' + nums2 + '.');
assert.ok(!/Restore applied/.test(second), 'not "Restore applied" again');
// One item matches: singular.
var third = w.run('2026-10-04', ['sam']);
var only = itemsFor(third, 'Sam');
assert.strictEqual(only.length, 1);
assert.strictEqual(notesOf(third)[0], 'Restored earlier — the digest that said so may not have reached you. The record (first seen Sep 30) could not be tied to one person and was set aside. The same commitment is listed below as matching item ' + only[0] + '.');
// Nothing matches today: nothing is claimed about having been read.
var gone = w.run('2026-10-05', []);
assert.strictEqual(notesOf(gone)[0], 'Restored earlier — the digest that said so may not have reached you. The record (first seen Sep 30) could not be tied to one person and was set aside. Nothing for this commitment is listed today. That does not mean it is resolved.');
assert.ok(!/was read|not in what was read/.test(notesOf(gone)[0]));
// The same, as a first note when nothing matches.
var w2 = world();
w2.corr(['--restore', w2.ref, '--now', '2026-10-02T09:00']);
var oc = w2.data(); oc.rows.forEach(function (r) { if (r[L.COL.key] === w2.key) r[L.COL.key] = w2.key + '|ambiguous'; });
Object.keys(oc.restoreRefs).forEach(function (r) { oc.restoreRefs[r].key = w2.key + '|ambiguous'; }); w2.save(oc);
var zero = w2.run('2026-10-02', []);
assert.strictEqual(notesOf(zero)[0], 'NOT RESTORED — ' + w2.ref + ' was set aside because the item could not be tied to one person, so it cannot be restored. If it is still outstanding it may be detected again as new, with a new age.', 'a restore refused as set aside never says it was applied');
assert.ok(!/Restore applied/.test(zero));

// Items the digest does not show are not numbered: older, more pressing items take the room, and the note says the matching items exist without giving numbers.
var w3 = world(14);
w3.corr(['--restore', w3.ref, '--now', '2026-10-02T09:00']);
var crowded = w3.run('2026-10-02', ['lena', 'sam']);
var alphaLines = crowded.split(NL).filter(function (l) { return /alpha/.test(l) && /^ ?d+ {2}/.test(l); });
assert.strictEqual(alphaLines.length, 0, 'the two matching items are not shown in this digest: ' + alphaLines.join(' / '));
assert.strictEqual(notesOf(crowded)[0], 'Restore applied to its record (first seen Sep 30), but the record could not be tied to one person, so it was set aside. The same commitment has 2 matching items, not shown in this digest.');

console.log('baseline and set-aside notes: OK');
