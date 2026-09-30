/* Midday alerts: what alerts, what never does, how a duplicate is prevented, and what a check
 * is forbidden to touch.
 *
 * The rules are comparisons on the detector's own fields, so the unit half feeds evaluate() items
 * shaped like the detector's; the integration half runs the real runner over connector text.
 * Dates are fixed: 2026-10-01 is a Thursday, 2026-10-03 a Saturday.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var A = require('../src/alerts.js');
var L = require('../src/ledger.js');
var { main } = require('../slack-run.js');
var cli = require('../tools/alerts.js');

var tmp = function () { return fs.mkdtempSync(path.join(os.tmpdir(), 'ol-alerts-')); };
// ON is what saying yes records: the shipped times. ON3 is a config with a third, custom check time.
var ON = { alerts: { delivery: 'dm', consentedAt: '2026-09-29T20:00:00Z', times: ['12:00', '15:00'] } };
var ON3 = { alerts: { delivery: 'dm', consentedAt: '2026-09-29T20:00:00Z', times: ['09:00', '12:00', '15:00'] } };
assert.deepStrictEqual(A.DEFAULT_TIMES, ['12:00', '15:00'], 'the shipped checks are at 12:00 and 15:00');
var now = function (s) { return A.parseNow(s); };

/* ------------------------------ consent is a record, and anything else is off ------------------------------ */
assert.ok(A.consent(ON) && A.consent(ON3), 'a consent record is on');
[undefined, {}, { alerts: false }, { alerts: true }, { alerts: { delivery: 'off', offeredAt: '2026-09-29T20:00:00Z' } },
 { alerts: { delivery: 'desktop', consentedAt: '2026-09-29T20:00:00Z' } },       // the ping that was never verified
 { alerts: { delivery: 'dm' } },                                                // no consent record
 { alerts: { delivery: 'dm', consentedAt: 'yesterday' } },
 { alerts: { delivery: 'dm', consentedAt: '2026-09-29T20:00:00Z', times: ['12:00', '09:00'] } },
 { alerts: { delivery: 'dm', consentedAt: '2026-09-29T20:00:00Z', times: ['09:00', '12:00', '15:00', '16:00'] } },
 { alerts: { delivery: 'dm', consentedAt: '2026-09-29T20:00:00Z', times: ['07:00'] } },
 { alerts: { delivery: 'dm', consentedAt: '2026-09-29T20:00:00Z', times: ['18:00'] } },
 { alerts: { delivery: 'dm', consentedAt: '2026-09-29T20:00:00Z', times: ['9am'] } }
].forEach(function (cfg, i) { assert.strictEqual(A.consent(cfg), null, 'case ' + i + ' is off: ' + JSON.stringify(cfg)); });

/* ------------------------------ the rules ------------------------------ */
var n = 0;
var mk = function (f) {
  n++;
  return Object.assign({ type: 'owed_to_us', threadId: '#c', said: '2026-09-28', what: 'thing ' + n, who: 'sam@x.example',
    subject: '#c', due: '2026-10-01', workDue: '2026-10-01', status: 'due_today', overdueDays: 0, risk: 50, rel: null }, f);
};
var TODAY = '2026-10-01';
var key = function (l) { return require('../src/loops.js').loopKey(l); };
var state = function (base, alerted) {
  var items = {};
  Object.keys(base || {}).forEach(function (k) { items[k] = base[k]; });
  return { baseline: { date: '2026-09-30', items: items }, alerted: alerted || {}, slots: {}, pending: null };
};
var ev = function (open, st, verdict) { return A.evaluate(open, st, TODAY, verdict); };
var keys = function (found) { return found.map(function (e) { return e.key; }); };

var overdue = mk({ status: 'overdue', due: '2026-09-29', workDue: '2026-09-29', overdueDays: 2 });
var dueToday = mk({});
var tomorrowPriority = mk({ due: '2026-10-02', workDue: '2026-10-02', status: 'due_soon', rel: { weight: 20 } });
var tomorrowOther = mk({ due: '2026-10-02', workDue: '2026-10-02', status: 'due_soon', rel: { weight: 4 } });
var laterPriority = mk({ due: '2026-10-05', workDue: '2026-10-05', status: 'due_soon', rel: { weight: 26 } });
var undated = mk({ due: null, workDue: null, status: 'open', overdueDays: 0 });
var damped = mk({ status: 'overdue', due: '2026-09-29', workDue: '2026-09-29', overdueDays: 2, earlyForThem: true });

assert.deepStrictEqual([overdue, dueToday, tomorrowPriority, tomorrowOther, laterPriority, undated, damped].map(function (l) { return A.level(l, TODAY); }),
  [3, 2, 1, 0, 0, 0, 0], 'levels: overdue 3, due today 2, a priority contact\'s due tomorrow 1, everything else 0');

// An item that was not in the last digest.
var found = ev([overdue, dueToday, tomorrowPriority, tomorrowOther, laterPriority, undated, damped], state({}));
assert.deepStrictEqual(keys(found).sort(), [key(overdue), key(dueToday), key(tomorrowPriority)].sort(),
  'a new item alerts when overdue, due today, or a priority contact\'s due tomorrow — and only then');
assert.ok(found.every(function (e) { return e.fresh; }));

// An item that was.
var seenAt = function (l, lv) { var o = {}; o[key(l)] = lv; return o; };
assert.deepStrictEqual(keys(ev([dueToday], state(seenAt(dueToday, 0)))), [key(dueToday)], 'it became due today');
assert.deepStrictEqual(keys(ev([dueToday], state(seenAt(dueToday, 2)))), [], 'it was already due today at the digest');
assert.deepStrictEqual(keys(ev([overdue], state(seenAt(overdue, 2)))), [key(overdue)], 'it became overdue');
assert.deepStrictEqual(keys(ev([overdue], state(seenAt(overdue, 3)))), [], 'it was already overdue');
assert.deepStrictEqual(keys(ev([tomorrowPriority], state(seenAt(tomorrowPriority, 0)))), [],
  'a priority contact\'s existing item reaching due tomorrow does not alert on its own — only a new one does');
assert.deepStrictEqual(keys(ev([tomorrowPriority], state(seenAt(tomorrowPriority, 1)))), []);

// Once per level, however many checks run.
var s1 = state({}, {}); s1.alerted[key(dueToday)] = 2;
assert.deepStrictEqual(keys(ev([dueToday], s1)), [], 'already alerted at this level');
s1.alerted[key(overdue)] = 2;
assert.deepStrictEqual(keys(ev([overdue], s1)), [key(overdue)], 'alerted when due today, so it alerts once more when overdue');
s1.alerted[key(overdue)] = 3;
assert.deepStrictEqual(keys(ev([overdue], s1)), []);

// What is never alerted.
['x', 'wrong', 'k', 'knew', 'already'].forEach(function (v) {
  assert.deepStrictEqual(keys(ev([overdue], state({}), function () { return v; })), [], 'a verdict of "' + v + '" never alerts');
});
assert.deepStrictEqual(keys(ev([overdue], state({}), function () { return ''; })), [key(overdue)]);
assert.deepStrictEqual(keys(ev([undated], state({}))), [], 'undated items stay in the digest');

// Most urgent first.
var hi = mk({ status: 'overdue', due: '2026-09-29', workDue: '2026-09-29', overdueDays: 2, risk: 140 }), lo = mk({ risk: 60 });
assert.deepStrictEqual(keys(ev([lo, hi], state({}))), [key(hi), key(lo)]);

/* ------------------------------ what does a run of the checks task do? ------------------------------ */
var dir = tmp();
A.writeBaseline(dir, [], '2026-09-30');
var d = function (cfg, t) { return A.decide(cfg, now(t), dir); };

assert.deepStrictEqual([d(ON, '2026-10-01T12:03').run, d(ON, '2026-10-01T12:03').slot, d(ON, '2026-10-01T12:03').date], ['CHECK', '12:00', '2026-10-01']);
assert.strictEqual(d(ON, '2026-10-01T15:00').slot, '15:00');
assert.strictEqual(d(ON, '2026-10-01T16:59').slot, '15:00', 'a 15:00 check still runs at 16:59');
assert.strictEqual(d(ON, '2026-10-01T13:59').run, 'CHECK', 'a minute short of two hours late still runs');
assert.strictEqual(d(ON, '2026-10-01T14:00').run, 'SKIP', 'two hours late is skipped: consent says "less than two hours ago"');
assert.ok(/120 minutes late/.test(d(ON, '2026-10-01T14:00').reason), d(ON, '2026-10-01T14:00').reason);
assert.strictEqual(d(ON, '2026-10-01T17:30').run, 'SKIP', 'the evening is not a check, and the digest is another task');
assert.strictEqual(d(ON, '2026-10-01T09:03').run, 'SKIP', 'there is no 09:00 check any more');
assert.ok(/before the first check \(12:00\)/.test(d(ON, '2026-10-01T09:03').reason), d(ON, '2026-10-01T09:03').reason);
assert.strictEqual(d(ON, '2026-10-01T07:30').run, 'SKIP');
assert.strictEqual(d(ON3, '2026-10-01T09:03').slot, '09:00', 'a config that names a third time still gets it');
assert.strictEqual(d(ON, '2026-10-03T12:00').run, 'SKIP', 'no checks on Saturday, even if someone runs the task by hand');
assert.ok(/weekend/.test(d(ON, '2026-10-04T12:00').reason));
assert.strictEqual(d(ON, '2026-10-05T12:02').run, 'CHECK', 'Monday');

// Alerts off: OFF, so the task pauses itself instead of starting empty sessions. It is never a digest.
['2026-10-01T12:03', '2026-10-01T18:00', '2026-10-03T12:00'].forEach(function (t) {
  assert.strictEqual(d({}, t).run, 'OFF', 'no alerts entry: ' + t);
  assert.strictEqual(d({ alerts: false }, t).run, 'OFF', 'alerts false: ' + t);
  assert.strictEqual(d({ alerts: { delivery: 'off', offAt: '2026-10-02T10:00:00Z' } }, t).run, 'OFF');
});
assert.ok(/nothing to do/.test(d({}, '2026-10-01T12:03').reason));

// A slot that has run is done; no baseline means nothing to compare with.
var ran = A.load(dir); ran.slots['2026-10-01'] = { '12:00': 'x' }; A.save(dir, ran);
assert.strictEqual(d(ON, '2026-10-01T12:30').run, 'SKIP', 'a rerun of a done slot does nothing');
assert.ok(/already ran/.test(d(ON, '2026-10-01T12:30').reason));
assert.strictEqual(d(ON, '2026-10-01T15:00').run, 'CHECK');
fs.writeFileSync(A.baselineFile(dir), '{}');
assert.ok(/no digest baseline/.test(d(ON, '2026-10-01T12:03').reason), 'no baseline yet');
fs.writeFileSync(A.baselineFile(dir), '{ torn');
assert.strictEqual(d(ON, '2026-10-01T12:03').run, 'SKIP', 'a torn baseline file reads as no baseline, not as a crash');
fs.writeFileSync(A.baselineFile(dir), JSON.stringify({ date: '2026-09-30', items: {} }));
assert.ok(/no digest baseline/.test(d(ON, '2026-10-01T12:03').reason), 'a baseline with no version is not one');

/* ------------------------------ a check, a post, a confirm ------------------------------ */
var cdir = tmp();
// A fresh digest baseline (no items) and no check record.
var fresh0 = function () { A.writeBaseline(cdir, [], '2026-09-30'); fs.rmSync(A.file(cdir), { force: true }); };
fresh0();
var text = A.check(cdir, ON3, { slot: '09:00', date: TODAY, today: TODAY, open: [overdue, dueToday], verdictOf: null,
  nameOf: function (w) { return 'Sam'; }, labels: { owed_to_us: 'They promised' } });
assert.ok(text.indexOf('OPEN LOOPS ALERT — 2026-10-01 09:00\n2 things changed since your last digest.') === 0, text);
assert.ok(/Next check 12:00\. Tonight's digest will number these; reply there to correct them\.$/.test(text), text);
assert.ok(!/^\s*\d+ {2}/m.test(text), 'unnumbered');
assert.ok(!/ref [0-9a-f]{4}/.test(text), 'no reference: nothing here is answered by number');
assert.ok(A.load(cdir).pending && Object.keys(A.load(cdir).pending.alerts).length === 2, 'recorded as pending, not yet as alerted');
assert.deepStrictEqual(A.load(cdir).alerted, {});
// Not posted: the next check finds the same two, and the slot is still open.
assert.ok(A.check(cdir, ON3, { slot: '12:00', date: TODAY, today: TODAY, open: [overdue, dueToday] }), 'an alert that was never confirmed is offered again');
assert.strictEqual(A.confirm(cdir), true);
assert.strictEqual(Object.keys(A.load(cdir).alerted).length, 2);
assert.ok(A.load(cdir).slots[TODAY]['12:00'], 'confirming completes its slot');
assert.strictEqual(A.confirm(cdir), false, 'nothing left to confirm');
assert.strictEqual(A.check(cdir, ON3, { slot: '15:00', date: TODAY, today: TODAY, open: [overdue, dueToday] }), null,
  'confirmed, so no later check says it again');
assert.ok(A.load(cdir).slots[TODAY]['15:00'], 'a check that finds nothing is complete at once');
assert.throws(function () { A.check(cdir, {}, { slot: '09:00', date: TODAY, today: TODAY, open: [] }); }, /alerts are off/);
assert.throws(function () { A.check(cdir, ON3, { slot: '10:00', date: TODAY, today: TODAY, open: [] }); }, /not one of the configured/);

// At most five in a message, most urgent first, and the rest said out loud.
var many = [], i;
for (i = 0; i < 7; i++) many.push(mk({ status: 'overdue', due: '2026-09-29', workDue: '2026-09-29', overdueDays: 2, risk: 100 + i }));
fresh0();
var big = A.check(cdir, ON3, { slot: '09:00', date: TODAY, today: TODAY, open: many, labels: { owed_to_us: 'They promised' } });
assert.strictEqual((big.match(/^• /gm) || []).length, 5, 'five items');
assert.ok(/^7 things changed/m.test(big) && /and 2 more in tonight's digest\./.test(big), big);
assert.ok(big.indexOf(many[6].what) < big.indexOf(many[2].what), 'highest risk first');
assert.strictEqual(Object.keys(A.load(cdir).pending.alerts).length, 5, 'only what was shown is recorded');

/* ------------------------------ a new digest baseline resets item dedupe, not the day's slots ------------------------------ */
var vdir = tmp();
var bytes = function (f) { return fs.existsSync(f) ? fs.readFileSync(f) : null; };
A.writeBaseline(vdir, [], '2026-09-30');
var v1 = A.load(vdir).baseline.version;
A.writeBaseline(vdir, [], '2026-09-30');
assert.notStrictEqual(A.load(vdir).baseline.version, v1, 'every digest writes a new version, even on the same day');
A.writeBaseline(vdir, [], '2026-09-30');
var vFirst = A.load(vdir).baseline.version;
assert.ok(A.check(vdir, ON, { slot: '12:00', date: TODAY, today: TODAY, open: [overdue] }));
assert.ok(A.confirm(vdir));
assert.strictEqual(Object.keys(A.load(vdir).alerted).length, 1);
var slot12 = function (dir, cfg) { return A.decide(cfg || ON, now('2026-10-01T12:30'), dir); };
assert.strictEqual(slot12(vdir).run, 'SKIP', 'the 12:00 slot is done');
assert.strictEqual(A.check(vdir, ON, { slot: '15:00', date: TODAY, today: TODAY, open: [overdue] }), null, 'and it is not alerted again');

A.writeBaseline(vdir, [overdue], TODAY);                                     // the digest that showed it
var afterDigest = A.load(vdir);
assert.notStrictEqual(afterDigest.baseline.version, vFirst);
assert.deepStrictEqual([afterDigest.alerted, afterDigest.pending], [{}, null], 'a new baseline version resets what was alerted');
assert.ok(afterDigest.slots[TODAY]['12:00'], 'but the 12:00 check that ran that day stays done');
assert.strictEqual(afterDigest.baseline.items[key(overdue)], 3, 'and the new baseline is what the digest showed');
assert.strictEqual(slot12(vdir).run, 'SKIP', 'a new baseline does not reopen it');
assert.strictEqual(A.decide(ON, now('2026-10-01T15:30'), vdir).run, 'SKIP', 'nor the 15:00 that ran too');
var again = A.check(vdir, ON, { slot: '15:00', date: TODAY, today: TODAY, open: [overdue, dueToday] });
assert.ok(again && /due today/.test(again) && !/days late/.test(again), 'only what is new since that digest');

// Run 12:00 (posted, confirmed), replace the baseline that day, rerun 12:00: nothing posts. 15:00 remains.
var sdir0 = tmp();
A.writeBaseline(sdir0, [], '2026-09-30');
var first = A.check(sdir0, ON, { slot: '12:00', date: TODAY, today: TODAY, open: [overdue] });
assert.ok(first && /^OPEN LOOPS ALERT — 2026-10-01 12:00/.test(first));
assert.ok(A.confirm(sdir0));
A.writeBaseline(sdir0, [], TODAY);                                           // a digest lands: new version, this baseline lacks the item
assert.strictEqual(A.decide(ON, now('2026-10-01T12:45'), sdir0).run, 'SKIP', 'the 12:00 rerun is refused');
assert.ok(/already ran/.test(A.decide(ON, now('2026-10-01T12:45'), sdir0).reason));
assert.strictEqual(A.decide(ON, now('2026-10-01T15:00'), sdir0).run, 'CHECK', '15:00 remains available');
assert.strictEqual(A.load(sdir0).alerted[key(overdue)], undefined, 'while item dedupe did reset');
// A check that found nothing completed its slot too.
var sdir1 = tmp();
A.writeBaseline(sdir1, [], '2026-09-30');
assert.strictEqual(A.check(sdir1, ON, { slot: '12:00', date: TODAY, today: TODAY, open: [] }), null);
A.writeBaseline(sdir1, [], TODAY);
assert.strictEqual(A.decide(ON, now('2026-10-01T12:45'), sdir1).run, 'SKIP', 'a quiet 12:00 stays done across a new baseline');
// The digest lands between the post and the confirm: item dedupe is void, the slot is still completed.
var sdir2 = tmp();
A.writeBaseline(sdir2, [], '2026-09-30');
assert.ok(A.check(sdir2, ON, { slot: '12:00', date: TODAY, today: TODAY, open: [overdue] }));
A.writeBaseline(sdir2, [], TODAY);
assert.strictEqual(A.confirm(sdir2), true, 'confirming still records the slot');
assert.deepStrictEqual([A.load(sdir2).alerted, A.decide(ON, now('2026-10-01T12:45'), sdir2).run], [{}, 'SKIP']);
// It is a calendar-day record: the next day's 12:00 is a new slot.
assert.strictEqual(A.decide(ON, now('2026-10-02T12:05'), sdir2).run, 'CHECK');

// A post that lands but is never confirmed (the run died, or the read-back failed) is offered again: the
// consent text says a repeat is possible, because item dedupe only exists once --confirm has run.
var cdir3 = tmp();
A.writeBaseline(cdir3, [], '2026-09-30');
var posted = A.check(cdir3, ON, { slot: '12:00', date: TODAY, today: TODAY, open: [overdue] });
var repeated = A.check(cdir3, ON, { slot: '15:00', date: TODAY, today: TODAY, open: [overdue] });
assert.ok(posted && repeated && repeated.indexOf(overdue.what) > -1 && posted.indexOf(overdue.what) > -1, 'the same item, posted twice');

/* ------------------------------ overlapping tasks: one writer per file ------------------------------ */
var odir = tmp();
A.writeBaseline(odir, [], '2026-09-30');
var vA = A.load(odir).baseline.version;

// A check posts, and a digest lands before the check is confirmed.
assert.ok(A.check(odir, ON, { slot: '12:00', date: TODAY, today: TODAY, open: [overdue] }));
var checksFile = bytes(A.file(odir));
A.writeBaseline(odir, [overdue], TODAY);
assert.deepStrictEqual(bytes(A.file(odir)), checksFile, 'the digest never touches the checks task\'s file');
var vB = A.load(odir).baseline.version;
assert.notStrictEqual(vB, vA);
var baselineFile1 = bytes(A.baselineFile(odir));
assert.strictEqual(A.confirm(odir), true, 'confirming still completes the slot');
assert.deepStrictEqual(bytes(A.baselineFile(odir)), baselineFile1, 'confirming never touches the digest\'s file');
var conf = A.load(odir);
assert.deepStrictEqual([conf.alerted, conf.pending, !!conf.slots[TODAY]['12:00']], [{}, null, true],
  'but the alert is void — the digest has shown it since — so nothing is remembered as alerted');

// A check that read the old baseline saves after the digest has written a new one.
var slow = A.load(odir);                                                     // reads version vB
A.writeBaseline(odir, [], '2026-10-01');                                     // the digest again: vC
var vC = A.load(odir).baseline.version;
var baselineFile2 = bytes(A.baselineFile(odir));
slow.alerted[key(dueToday)] = 2; slow.slots[TODAY] = { '12:00': 'x' };
A.save(odir, slow);                                                          // the slow check's write lands late
assert.deepStrictEqual(bytes(A.baselineFile(odir)), baselineFile2, 'a late check write cannot disturb the baseline');
assert.strictEqual(A.load(odir).baseline.version, vC);
var late = A.load(odir);
assert.deepStrictEqual([late.alerted, Object.keys(late.slots[TODAY])], [{}, ['12:00']],
  'what it alerted was about an older baseline, so it is void; that it ran is not');
assert.ok(A.check(odir, ON, { slot: '15:00', date: TODAY, today: TODAY, open: [dueToday] }), 'and the next check starts clean, on the new baseline');
assert.ok(A.confirm(odir));
assert.strictEqual(A.load(odir).baseline.version, vC);
assert.strictEqual(A.load(odir).alerted[key(dueToday)], 2);

// Really at once: a digest rewriting its baseline in one process while checks run in another.
// Each file has one writer, so every read must find a whole file and no check may find "no baseline".
var sdir = tmp();
A.writeBaseline(sdir, [], '2026-09-30');
var stress = function (body) {
  return 'var A=require(' + JSON.stringify(path.join(__dirname, '..', 'src', 'alerts.js')) + ');' +
    'var dir=' + JSON.stringify(sdir) + ',ON=' + JSON.stringify(ON) + ',item=' + JSON.stringify(overdue) + ';' + body;
};
var digestLoop = stress('for(var i=0;i<300;i++)A.writeBaseline(dir,i%2?[item]:[],"2026-10-01");');
var checksLoop = stress('var bad=0;for(var i=0;i<300;i++){try{A.check(dir,ON,{slot:"12:00",date:"2026-10-01",today:"2026-10-01",open:[item]});A.confirm(dir);}' +
  'catch(e){bad++;console.error(e.message);}}process.exit(bad?1:0);');
var both = require('child_process').spawnSync(process.execPath, ['-e',
  'var cp=require("child_process"),n=2,bad=0;' +
  '[' + JSON.stringify(digestLoop) + ',' + JSON.stringify(checksLoop) + '].forEach(function(c){' +
  'cp.spawn(process.execPath,["-e",c],{stdio:"inherit"}).on("exit",function(code){bad+=code?1:0;if(!--n)process.exit(bad);});});'],
  { encoding: 'utf8' });
assert.strictEqual(both.status, 0, 'overlapping digest and checks writes: ' + both.stderr);
var fin = A.load(sdir);
assert.ok(fin.baseline && fin.baseline.version, 'the baseline is whole after the overlap');
JSON.parse(fs.readFileSync(A.file(sdir), 'utf8'));                          // and so is the checks file

/* ------------------------------ the real runner ------------------------------ */
var ME = 'you@example.com';
var at = function (mo, day, h) { return (Date.UTC(2026, mo - 1, day, h) / 1000).toFixed(6); };
var msg = function (nm, em, uid, ts, body) {
  return ['=== Message from ' + nm + ' <' + em + '> (' + uid + ') at ' + ts + ' UTC ===', 'Message TS: ' + ts, body].join('\n');
};
var me = function (ts, body) { return msg('Alex Rivera', ME, 'U0EXAMPLE001', ts, body); };
var lena = function (ts, body) { return msg('Lena Borg', 'lena@vectorfreight.example', 'U0EXAMPLE002', ts, body); };
var sam = function (ts, body) { return msg('Sam Okafor', 'sam@northstar.example', 'U0EXAMPLE003', ts, body); };

var rdir = tmp();
var cfgPath = path.join(rdir, 'openloops.config.json'), ledger = path.join(rdir, 'ledger.json');
var writeCfg = function (extra) {
  fs.writeFileSync(cfgPath, JSON.stringify(Object.assign({ you: ME, selfDm: 'U0EXAMPLE001', tzOffset: 0, spotCheck: 0, ledger: ledger,
    contacts: { 'vectorfreight.example': { tier: 'key_account', label: 'Vector Freight' } } }, extra || {})));
};
var input = function (today, extra, dm) {
  var p = path.join(rdir, 'in-' + today + '.json');
  var chat = [lena(at(9, 28, 14), "We'll get the revised contract back to you Thursday Oct 1."),
              me(at(9, 25, 14), "I'll send the scope doc Wednesday."),
              me(at(9, 25, 15), "I'll send the deck when I can.")].concat(extra || []);
  fs.writeFileSync(p, JSON.stringify({ today: today, conversations: [{ channel: '#vector-freight', members: [], text: chat.join('\n') }],
    dm: { channel: 'D0', text: dm || '' } }));
  return p;
};
var checkArgs = function (today, slot, t, extra, dm) {
  return [input(today, extra, dm), '--config', cfgPath, '--check', '--slot', slot, '--today', today, '--now', t];
};

writeCfg(ON3);
// A dry digest writes nothing, so it cannot fake a baseline.
main([input('2026-09-30'), '--config', cfgPath, '--dry']);
assert.ok(!fs.existsSync(A.baselineFile(rdir)) && !fs.existsSync(A.file(rdir)), 'a dry run writes no baseline');
assert.ok(/^SKIP — no digest baseline yet/.test(cli.main(['--which', '--now', '2026-10-01T09:05', '--config', cfgPath])), 'no digest has run yet, so there is nothing to compare with');

// The evening digest writes it.
/* A digest run only stages its baseline; it is promoted once the digest is posted and read back. */
var posted = function (t) {
  return cli.main(['--baseline', '--ref', (t.split(String.fromCharCode(10))[0].match(/ref ([0-9a-f]{4})/) || [])[1], '--config', cfgPath]);
};
var digest1 = main([input('2026-09-30'), '--config', cfgPath]);
assert.ok(!fs.existsSync(A.baselineFile(rdir)), 'the run itself writes no baseline');
posted(digest1);
var b = A.load(rdir).baseline;
assert.strictEqual(b.date, '2026-09-30');
assert.deepStrictEqual(Object.keys(b.items).map(function (k) { return b.items[k]; }).sort(), [0, 1, 2],
  'the deck (undated) 0, Lena\'s due tomorrow 1, the scope doc due that day 2');
assert.ok(!/scope doc|Lena|contract/.test(fs.readFileSync(A.baselineFile(rdir), 'utf8')), 'the baseline holds keys and levels, no message text');
assert.strictEqual(cli.main(['--which', '--now', '2026-10-01T09:05', '--config', cfgPath]), 'CHECK 09:00 2026-10-01 — check 09:00');

// Thursday 09:05. New: Sam promises today; Lena promises another thing for tomorrow (a priority contact); Sam promises tomorrow (not).
var fresh = [sam(at(10, 1, 12), "We'll send you the signed MSA Thursday Oct 1."),
             lena(at(10, 1, 13), "We'll send the revised SOW Friday Oct 2."),
             sam(at(10, 1, 14), "We'll send the invoice Friday Oct 2.")];
var ledgerBefore = bytes(ledger), baselineBefore = bytes(A.baselineFile(rdir));
var realErr = process.stderr.write, errText = '';
process.stderr.write = function (t) { errText += t; return true; };
var alert1;
try { alert1 = main(checkArgs('2026-10-01', '09:00', '2026-10-01T09:05', fresh)); } finally { process.stderr.write = realErr; }
var alertId1 = (errText.match(/^alert id: ([0-9a-f]{16})$/m) || [])[1];
assert.ok(alertId1 && alertId1 === A.load(rdir).pending.id, 'the check prints the pending alert id on stderr, not in the message: ' + errText);
assert.ok(alert1.indexOf('alert id') === -1, 'the message to post carries no id');
assert.ok(alert1.indexOf('OPEN LOOPS ALERT — 2026-10-01 09:00\n4 things changed since your last digest.') === 0, alert1);
var fresh1 = alert1.slice(alert1.indexOf('New and urgent'), alert1.indexOf('Now overdue'));
assert.ok(/• They promised — Sam: "We'll send you the signed MSA Thursday Oct 1\." \(#vector-freight\) · due today/.test(fresh1), alert1);
assert.ok(/• They promised — Lena: "We'll send the revised SOW Friday Oct 2\." \(#vector-freight\) · due tomorrow/.test(fresh1), 'a priority contact\'s new item due tomorrow');
assert.ok(fresh1.indexOf('Lena') < fresh1.indexOf('Sam'), 'the priority contact ranks first');
assert.ok(!/invoice/.test(alert1), 'a new item due tomorrow from anyone else does not');
assert.ok(/Now overdue\n• You promised — "I'll send the scope doc Wednesday\." \(#vector-freight\) · 1 day late/.test(alert1), 'the scope doc slipped');
assert.ok(/Now due today\n• They promised — Lena: "We'll get the revised contract back to you Thursday Oct 1\." \(#vector-freight\) · due today/.test(alert1), alert1);
assert.ok(!/deck/.test(alert1), 'undated: digest only');
assert.deepStrictEqual(bytes(ledger), ledgerBefore, 'a check never writes the ledger');
assert.ok(A.load(rdir).pending, 'pending until confirmed');
assert.deepStrictEqual(bytes(A.baselineFile(rdir)), baselineBefore, 'a check never writes the digest\'s baseline');

// Posted and confirmed: the 12:00 check has nothing to say about them — and a new one still does.
assert.ok(/Confirmed/.test(cli.main(['--confirm', '--id', alertId1, '--config', cfgPath])));
assert.ok(/^NO ALERT/.test(main(checkArgs('2026-10-01', '12:00', '2026-10-01T12:05', fresh))), 'the same items are not alerted twice');
assert.deepStrictEqual(bytes(ledger), ledgerBefore, 'still the ledger, untouched');
var later = fresh.concat(lena(at(10, 1, 15), "We'll send the updated rate card Thursday Oct 1."));
var alert3 = main(checkArgs('2026-10-01', '15:00', '2026-10-01T15:02', later));
assert.ok(/^OPEN LOOPS ALERT — 2026-10-01 15:00\n1 thing changed/.test(alert3) && /rate card/.test(alert3) && !/Next check/.test(alert3), alert3);

// Refusals: not gated, wrong slot, wrong date, off.
assert.ok(/^SKIP — the 15:00 check is due, not 09:00/.test(main(checkArgs('2026-10-01', '09:00', '2026-10-01T15:02', fresh))), 'the runner decides again');
assert.ok(/^SKIP — weekend/.test(main(checkArgs('2026-10-03', '12:00', '2026-10-03T12:05', fresh))), 'the runner refuses a weekend check too');
assert.throws(function () { main([input('2026-10-01', fresh), '--config', cfgPath, '--check', '--slot', '15:00', '--today', '2026-09-30', '--now', '2026-10-01T15:05']); },
  /--today 2026-10-01/);
assert.throws(function () { main([input('2026-10-01', fresh), '--config', cfgPath, '--check', '--now', '2026-10-01T12:05', '--today', '2026-10-01']); }, /--slot/);
writeCfg({ alerts: false });
var offBefore = [bytes(A.file(rdir)), bytes(A.baselineFile(rdir))];
assert.ok(/^ALERTS OFF/.test(main(checkArgs('2026-10-01', '12:00', '2026-10-01T12:05', fresh))));
assert.deepStrictEqual([bytes(A.file(rdir)), bytes(A.baselineFile(rdir))], offBefore, 'off: nothing written');
writeCfg(ON3);

// A reply typed in the DM before the check counts: an item the reader rejected does not alert.
var dmDigest = me(at(9, 30, 22), '```\n' + digest1 + '\n```');
var rejection = me(at(10, 1, 11), '1');                                      // item 1 was the scope doc
fs.rmSync(A.file(rdir), { force: true });                                    // a clean check record, same baseline
var afterReply = main(checkArgs('2026-10-01', '09:00', '2026-10-01T09:05', fresh, dmDigest + '\n' + rejection));
assert.ok(!/scope doc/.test(afterReply) && /^OPEN LOOPS ALERT/.test(afterReply), 'the rejected item does not alert; the rest do');
assert.deepStrictEqual(bytes(ledger), ledgerBefore, 'and a reply read by a check is not recorded');

/* ------------------------------ digests and replies are untouched ------------------------------ */
// The DM reader must skip an alert: its second line begins with a number, which reads as a rejection
// of that item. This one is in range of the digest's three items, so only the skip protects item 1.
var alertMsg = me(at(10, 1, 13), [
  'OPEN LOOPS ALERT — 2026-10-01 09:00',
  '1 thing changed since your last digest.',
  '',
  'Now overdue',
  '• You promised — "x" (#vector-freight) · 1 day late',
  '',
  'Next check 12:00. Tonight\'s digest will number these; reply there to correct them.'].join('\n'));
fs.rmSync(ledger); fs.rmSync(A.file(rdir), { force: true }); fs.rmSync(A.baselineFile(rdir));
var d1 = main([input('2026-09-30'), '--config', cfgPath]);
posted(d1);
var refOf = function (t) { return (t.split('\n')[0].match(/· ref ([0-9a-f]{4})$/) || [])[1]; };
var dm2 = me(at(9, 30, 22), '```\n' + d1 + '\n```') + '\n' + alertMsg;
// Something alerted before this digest: the digest's baseline already contains it, so the record starts again.
var st = A.load(rdir); st.alerted = { 'some|key': 3 }; st.pending = { date: '2026-10-01', slot: '09:00', alerts: { 'some|key': 3 } };
A.save(rdir, st);
assert.deepStrictEqual(Object.keys(A.load(rdir).alerted), ['some|key'], 'the record is there before the digest');
var d2 = main([input('2026-10-01', fresh, dm2), '--config', cfgPath]);
posted(d2);
var rows = JSON.parse(fs.readFileSync(ledger, 'utf8')).rows;
assert.ok(rows.length >= 3 && rows.every(function (r) { return !r[L.COL.verdict]; }), 'an alert in the DM rejects nothing: ' + JSON.stringify(rows.map(function (r) { return r[7]; })));
assert.ok(!/Took your last reply|NOT APPLIED/.test(d2), 'and is not read as a reply at all');
assert.ok(A.load(rdir).baseline.date === '2026-10-01' && Object.keys(A.load(rdir).alerted).length === 0 &&
  Object.keys((A.load(rdir).pending || { alerts: {} }).alerts).length === 0,
  'the next digest rewrites the baseline and starts the alerted record again');

// A digest run with no config file has nowhere to keep a baseline, and writes none into the working directory.
var here = process.cwd(), lone = tmp();
process.chdir(lone);
var loneIn = input('2026-09-30'), loneJson = JSON.parse(fs.readFileSync(loneIn, 'utf8'));
loneJson.self = ME; loneJson.tzOffset = 0; loneJson.spotCheck = 0;
fs.writeFileSync(loneIn, JSON.stringify(loneJson));
try { main([loneIn, '--ledger', path.join(lone, 'lone-ledger.json')]); } finally { process.chdir(here); }
assert.ok(fs.existsSync(path.join(lone, 'lone-ledger.json')), 'the digest itself ran and recorded');
assert.ok(!fs.existsSync(path.join(lone, 'alerts-baseline.json')) && !fs.existsSync(path.join(lone, 'alerts.json')), 'no config, no baseline');

// A digest is the same digest with or without alerts: same numbering, same reference.
var plainDir = tmp(), plainCfg = path.join(plainDir, 'openloops.config.json');
fs.writeFileSync(plainCfg, JSON.stringify({ you: ME, selfDm: 'U0EXAMPLE001', tzOffset: 0, spotCheck: 0, ledger: path.join(plainDir, 'ledger.json'),
  contacts: { 'vectorfreight.example': { tier: 'key_account', label: 'Vector Freight' } } }));
var plain = main([input('2026-09-30'), '--config', plainCfg]);
assert.strictEqual(plain, digest1, 'alerts change nothing about the digest');
assert.strictEqual(refOf(plain), refOf(digest1));

/* ------------------------------ the command line ------------------------------ */
var cdir2 = tmp(), ccfg = path.join(cdir2, 'openloops.config.json');
fs.writeFileSync(ccfg, JSON.stringify({ you: ME }));
var asked = cli.main(['--consent', '--config', ccfg]);
assert.ok(/^\*\*Midday alerts — off unless you say yes\.\*\*/.test(asked) && /\*\*Turn on midday alerts\?\*\* yes \/ \*\*no\*\*\n/.test(asked));
assert.strictEqual(A.consent(JSON.parse(fs.readFileSync(ccfg, 'utf8'))), null, 'asking records nothing');
var skill = fs.readFileSync(path.join(__dirname, '..', 'skills', 'open-loops', 'SKILL.md'), 'utf8').split(String.fromCharCode(13)).join('');
cli.consentText().split('\n').filter(Boolean).forEach(function (l) { assert.ok(skill.indexOf('> ' + l) > -1, 'SKILL.md\'s own words: ' + l); });
['At 12:00 and 15:00 **your local time** on weekdays', 'normally at most\ntwo alerts a day', 'A repeat is possible', 'can post the same items again', 'Slack may not notify you', 'routine notification after every check',
 'more than two hours late is skipped', 'for a priority', 'Saying yes adds a second scheduled task', 'Your daily digest task is not changed',
 'still starts one\nfinal, empty session at its next run and pauses itself then'].forEach(function (p) { assert.ok(asked.indexOf(p) > -1, 'consent says: ' + p); });
assert.ok(!/another scheduled task/.test(asked), 'no claim that another running task skips a check');
assert.ok(!/09:00|three alerts/.test(asked), 'no 09:00 check');
assert.ok(!/desktop notification from the Claude app|count only|count-only/i.test(asked), 'the unverified ping is not promised');
assert.ok(!/edits your existing/.test(asked), 'the digest task is not edited');
assert.ok(/Midday alerts on/.test(cli.main(['--consent', '--yes', '--config', ccfg])));
assert.ok(A.consent(JSON.parse(fs.readFileSync(ccfg, 'utf8'))), '--yes records');
assert.ok(/Alerts on at 12:00, 15:00/.test(cli.main(['--status', '--config', ccfg])));
assert.ok(/Recorded/.test(cli.main(['--decline', '--config', ccfg])));
assert.strictEqual(A.consent(JSON.parse(fs.readFileSync(ccfg, 'utf8'))), null, 'declining turns it off');
assert.ok(/declined/.test(cli.main(['--status', '--config', ccfg])));
assert.strictEqual(JSON.parse(fs.readFileSync(ccfg, 'utf8')).you, ME, 'the rest of the config is left as it was');

// Turning alerts off after they were on: recorded, the offer date kept, and the task told to stop.
cli.main(['--consent', '--yes', '--config', ccfg]);
var onAt = JSON.parse(fs.readFileSync(ccfg, 'utf8')).alerts.consentedAt;
assert.ok(/Alerts are off\. Pause or delete the "Open Loops checks" scheduled task; the daily digest task is not affected/.test(cli.main(['--off', '--config', ccfg])));
var offCfg = JSON.parse(fs.readFileSync(ccfg, 'utf8'));
assert.strictEqual(A.consent(offCfg), null);
assert.strictEqual(offCfg.alerts.offeredAt, onAt, 'when it was first offered is kept, not replaced by now');
assert.ok(offCfg.alerts.offAt && /turned off/.test(cli.main(['--status', '--config', ccfg])));
assert.ok(/^OFF — /.test(cli.main(['--which', '--now', '2026-10-01T09:05', '--config', ccfg])), 'and the next run of the checks task is told OFF');

/* ------------------------------ the offer is not part of a scheduled run ------------------------------ */
var inDigest = skill.slice(skill.indexOf('## Running the digest'), skill.indexOf('## Midday check'));
var inCheck = skill.slice(skill.indexOf('## Midday check'), skill.indexOf('## Scheduling it'));
assert.ok(!/Midday alerts — off unless/.test(inDigest + inCheck), 'a scheduled run never reads the question');
assert.ok(skill.indexOf('Midday alerts — off unless') > skill.indexOf('## Scheduling it'));
assert.ok(skill.indexOf('tools/dm-lookup.js') > -1 && !/limit=15/.test(skill), 'the digest lookup pages on until it finds a digest, so alerts posted between digests cannot push it out (a wider fixed read was the old, insufficient answer)');

/* ------------------------------ the schedule ------------------------------ */
var offer = skill.slice(skill.indexOf('### Offering midday alerts'), skill.indexOf('## Changing it, or stopping it'));
assert.ok(/`0 12,15 \* \* 1-5`/.test(offer), 'the checks task is 12:00 and 15:00, weekdays only, so no empty weekend sessions');
assert.ok(!/0 9,12,15|0 12,15,18/.test(skill), 'and never rides on the digest task\'s schedule');
assert.ok(/Do not edit the daily digest task/.test(offer));
assert.ok(!/DIGEST, CHECK|On `DIGEST`|On DIGEST/.test(inCheck + offer), 'the checks task is never sent to the digest');
assert.ok(/`OFF`[^]*update_scheduled_task[^]*enabled: false/.test(inCheck), 'a task that finds alerts off pauses itself');
assert.ok(/Turning alerts off/.test(offer) && /never touched/.test(offer));
var agents = fs.readFileSync(path.join(__dirname, '..', 'AGENTS.md'), 'utf8');
assert.ok(/`open-loops-daily`/.test(agents) && /`open-loops-checks`/.test(agents) && /never writes the ledger/.test(agents),
  'AGENTS.md names both tasks that may post to the self-DM, and says which writes the ledger');
assert.ok(/does not run `--check`/.test(agents), 'and that every other agent stays out of checks');

console.log('alerts: OK');
