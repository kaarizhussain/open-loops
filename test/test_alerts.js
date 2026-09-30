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
var ON = { alerts: { delivery: 'dm', consentedAt: '2026-09-29T20:00:00Z', times: ['09:00', '12:00', '15:00'] } };
var now = function (s) { return A.parseNow(s); };

/* ------------------------------ consent is a record, and anything else is off ------------------------------ */
assert.ok(A.consent(ON), 'a consent record is on');
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

/* ------------------------------ which run is this? ------------------------------ */
var dir = tmp();
var yest = function (d) { return [A.addDays(d, -1)]; };
var seen = ['2026-09-30'];                                    // the last digest: Wednesday evening
var base = { baseline: { date: '2026-09-30', items: {} }, alerted: {}, slots: {}, pending: null };
fs.writeFileSync(A.file(dir), JSON.stringify(base));
var d = function (cfg, t, dates) { return A.decide(cfg, now(t), dir, dates || seen); };

assert.deepStrictEqual([d(ON, '2026-10-01T09:03').run, d(ON, '2026-10-01T09:03').slot, d(ON, '2026-10-01T09:03').date], ['CHECK', '09:00', '2026-10-01']);
assert.strictEqual(d(ON, '2026-10-01T12:04').slot, '12:00');
assert.strictEqual(d(ON, '2026-10-01T15:00').slot, '15:00');
assert.strictEqual(d(ON, '2026-10-01T18:02').run, 'DIGEST', 'the evening run is the digest');
assert.strictEqual(d(ON, '2026-10-01T17:00').run, 'DIGEST');
assert.strictEqual(d(ON, '2026-10-01T16:59').slot, '15:00', 'a 15:00 check can still run at 16:59, and from 17:00 the run is the digest');
assert.strictEqual(d(ON, '2026-10-01T11:00').run, 'CHECK', 'exactly two hours late still runs');
assert.strictEqual(d(ON, '2026-10-01T11:01').run, 'SKIP');
assert.ok(/late/.test(d(ON, '2026-10-01T11:01').reason), d(ON, '2026-10-01T11:01').reason);
assert.strictEqual(d(ON, '2026-10-01T08:30').run, 'SKIP');
assert.strictEqual(d(ON, '2026-10-03T12:00', ['2026-10-02']).run, 'SKIP', 'no checks on Saturday');
assert.ok(/weekend/.test(d(ON, '2026-10-04T12:00', ['2026-10-03']).reason));
assert.strictEqual(d(ON, '2026-10-05T09:02', ['2026-10-04']).run, 'CHECK', 'Monday, after a Sunday digest');
assert.strictEqual(d(ON, '2026-10-04T18:00', ['2026-10-03']).run, 'DIGEST', 'the weekend digest still runs');

// Alerts off: never a check, and never a digest at check time.
assert.strictEqual(d({}, '2026-10-01T09:03').run, 'SKIP', 'off: a 09:00 run is not a digest');
assert.strictEqual(d({ alerts: false }, '2026-10-01T12:00').run, 'SKIP');
assert.strictEqual(d({}, '2026-10-01T18:00').run, 'DIGEST');

// A missed evening digest is caught up by the next run, whatever its time — and only once.
assert.strictEqual(d(ON, '2026-10-01T09:03', ['2026-09-29']).run, 'DIGEST', 'no digest for yesterday: this run is its catch-up');
assert.strictEqual(d({}, '2026-10-01T09:03', ['2026-09-29']).run, 'DIGEST', 'also with alerts off');
assert.strictEqual(d(ON, '2026-10-01T12:00', ['2026-09-29', '2026-10-01']).run, 'CHECK', 'once today has a digest, checks resume');

// A slot that has run is done; no baseline means nothing to compare with.
fs.writeFileSync(A.file(dir), JSON.stringify(Object.assign({}, base, { slots: { '2026-10-01': { '09:00': 'x' } } })));
assert.strictEqual(d(ON, '2026-10-01T09:30').run, 'SKIP', 'a rerun of a done slot does nothing');
assert.ok(/already ran/.test(d(ON, '2026-10-01T09:30').reason));
assert.strictEqual(d(ON, '2026-10-01T12:00').run, 'CHECK');
fs.writeFileSync(A.file(dir), '{}');
assert.ok(/no digest baseline/.test(d(ON, '2026-10-01T09:03').reason), 'no baseline yet');
fs.writeFileSync(A.file(dir), '{ torn');
assert.strictEqual(d(ON, '2026-10-01T09:03').run, 'SKIP', 'a torn state file reads as no baseline, not as a crash');

/* ------------------------------ a check, a post, a confirm ------------------------------ */
var cdir = tmp();
var save = function (o) { fs.writeFileSync(A.file(cdir), JSON.stringify(o)); };
save(state({}));
var text = A.check(cdir, ON, { slot: '09:00', date: TODAY, today: TODAY, open: [overdue, dueToday], verdictOf: null,
  nameOf: function (w) { return 'Sam'; }, labels: { owed_to_us: 'They promised' } });
assert.ok(text.indexOf('OPEN LOOPS ALERT — 2026-10-01 09:00\n2 things changed since your last digest.') === 0, text);
assert.ok(/Next check 12:00\. Tonight's digest will number these; reply there to correct them\.$/.test(text), text);
assert.ok(!/^\s*\d+ {2}/m.test(text), 'unnumbered');
assert.ok(!/ref [0-9a-f]{4}/.test(text), 'no reference: nothing here is answered by number');
assert.ok(A.load(cdir).pending && Object.keys(A.load(cdir).pending.alerts).length === 2, 'recorded as pending, not yet as alerted');
assert.deepStrictEqual(A.load(cdir).alerted, {});
// Not posted: the next check finds the same two, and the slot is still open.
assert.ok(A.check(cdir, ON, { slot: '12:00', date: TODAY, today: TODAY, open: [overdue, dueToday] }), 'an alert that was never confirmed is offered again');
assert.strictEqual(A.confirm(cdir), true);
assert.strictEqual(Object.keys(A.load(cdir).alerted).length, 2);
assert.ok(A.load(cdir).slots[TODAY]['12:00'], 'confirming completes its slot');
assert.strictEqual(A.confirm(cdir), false, 'nothing left to confirm');
assert.strictEqual(A.check(cdir, ON, { slot: '15:00', date: TODAY, today: TODAY, open: [overdue, dueToday] }), null,
  'confirmed, so no later check says it again');
assert.ok(A.load(cdir).slots[TODAY]['15:00'], 'a check that finds nothing is complete at once');
assert.throws(function () { A.check(cdir, {}, { slot: '09:00', date: TODAY, today: TODAY, open: [] }); }, /alerts are off/);
assert.throws(function () { A.check(cdir, ON, { slot: '10:00', date: TODAY, today: TODAY, open: [] }); }, /not one of the configured/);

// At most five in a message, most urgent first, and the rest said out loud.
var many = [], i;
for (i = 0; i < 7; i++) many.push(mk({ status: 'overdue', due: '2026-09-29', workDue: '2026-09-29', overdueDays: 2, risk: 100 + i }));
save(state({}));
var big = A.check(cdir, ON, { slot: '09:00', date: TODAY, today: TODAY, open: many, labels: { owed_to_us: 'They promised' } });
assert.strictEqual((big.match(/^• /gm) || []).length, 5, 'five items');
assert.ok(/^7 things changed/m.test(big) && /and 2 more in tonight's digest\./.test(big), big);
assert.ok(big.indexOf(many[6].what) < big.indexOf(many[2].what), 'highest risk first');
assert.strictEqual(Object.keys(A.load(cdir).pending.alerts).length, 5, 'only what was shown is recorded');

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
var bytes = function (f) { return fs.existsSync(f) ? fs.readFileSync(f) : null; };

writeCfg(ON);
// A dry digest writes nothing, so it cannot fake a baseline.
main([input('2026-09-30'), '--config', cfgPath, '--dry']);
assert.ok(!fs.existsSync(A.file(rdir)), 'a dry run writes no baseline');
assert.ok(/^DIGEST — .*catch-up/.test(cli.main(['--which', '--now', '2026-10-01T09:05', '--config', cfgPath])), 'no digest has run yet, so the next run is one');

// The evening digest writes it.
var digest1 = main([input('2026-09-30'), '--config', cfgPath]);
var b = A.load(rdir).baseline;
assert.strictEqual(b.date, '2026-09-30');
assert.deepStrictEqual(Object.keys(b.items).map(function (k) { return b.items[k]; }).sort(), [0, 1, 2],
  'the deck (undated) 0, Lena\'s due tomorrow 1, the scope doc due that day 2');
assert.ok(!/scope doc|Lena|contract/.test(fs.readFileSync(A.file(rdir), 'utf8')), 'the baseline holds keys and levels, no message text');
assert.strictEqual(cli.main(['--which', '--now', '2026-10-01T09:05', '--config', cfgPath]), 'CHECK 09:00 2026-10-01 — check 09:00');

// Thursday 09:05. New: Sam promises today; Lena promises another thing for tomorrow (a priority contact); Sam promises tomorrow (not).
var fresh = [sam(at(10, 1, 12), "We'll send you the signed MSA Thursday Oct 1."),
             lena(at(10, 1, 13), "We'll send the revised SOW Friday Oct 2."),
             sam(at(10, 1, 14), "We'll send the invoice Friday Oct 2.")];
var ledgerBefore = bytes(ledger), stateBefore = bytes(A.file(rdir));
var alert1 = main(checkArgs('2026-10-01', '09:00', '2026-10-01T09:05', fresh));
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

// Posted and confirmed: the 12:00 check has nothing to say about them — and a new one still does.
assert.ok(/Confirmed/.test(cli.main(['--confirm', '--config', cfgPath])));
assert.ok(/^NO ALERT/.test(main(checkArgs('2026-10-01', '12:00', '2026-10-01T12:05', fresh))), 'the same items are not alerted twice');
assert.deepStrictEqual(bytes(ledger), ledgerBefore, 'still the ledger, untouched');
var later = fresh.concat(lena(at(10, 1, 15), "We'll send the updated rate card Thursday Oct 1."));
var alert3 = main(checkArgs('2026-10-01', '15:00', '2026-10-01T15:02', later));
assert.ok(/^OPEN LOOPS ALERT — 2026-10-01 15:00\n1 thing changed/.test(alert3) && /rate card/.test(alert3) && !/Next check/.test(alert3), alert3);

// Refusals: not gated, wrong slot, wrong date, off.
assert.ok(/^SKIP — the 15:00 check is due, not 09:00/.test(main(checkArgs('2026-10-01', '09:00', '2026-10-01T15:02', fresh))), 'the runner decides again');
assert.ok(/^SKIP — no digest is recorded for 2026-10-02/.test(main(checkArgs('2026-10-03', '12:00', '2026-10-03T12:05', fresh))),
  'a check is refused while a digest is owed; the weekend rule itself is in decide()');
assert.throws(function () { main([input('2026-10-01', fresh), '--config', cfgPath, '--check', '--slot', '15:00', '--today', '2026-09-30', '--now', '2026-10-01T15:05']); },
  /--today 2026-10-01/);
assert.throws(function () { main([input('2026-10-01', fresh), '--config', cfgPath, '--check', '--now', '2026-10-01T12:05', '--today', '2026-10-01']); }, /--slot/);
writeCfg({ alerts: false });
var offBefore = bytes(A.file(rdir));
assert.ok(/^ALERTS OFF/.test(main(checkArgs('2026-10-01', '12:00', '2026-10-01T12:05', fresh))));
assert.deepStrictEqual(bytes(A.file(rdir)), offBefore, 'off: nothing written');
writeCfg(ON);

// A reply typed in the DM before the check counts: an item the reader rejected does not alert.
var dmDigest = me(at(9, 30, 22), '```\n' + digest1 + '\n```');
var rejection = me(at(10, 1, 11), '1');                                      // item 1 was the scope doc
fs.writeFileSync(A.file(rdir), JSON.stringify(Object.assign(A.load(rdir), { alerted: {}, pending: null, slots: {} })));
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
fs.rmSync(ledger); fs.rmSync(A.file(rdir));
var d1 = main([input('2026-09-30'), '--config', cfgPath]);
var refOf = function (t) { return (t.split('\n')[0].match(/· ref ([0-9a-f]{4})$/) || [])[1]; };
var dm2 = me(at(9, 30, 22), '```\n' + d1 + '\n```') + '\n' + alertMsg;
// Something alerted before this digest: the digest's baseline already contains it, so the record starts again.
var st = A.load(rdir); st.alerted = { 'some|key': 3 }; st.pending = { date: '2026-10-01', slot: '09:00', alerts: { 'some|key': 3 } };
fs.writeFileSync(A.file(rdir), JSON.stringify(st));
var d2 = main([input('2026-10-01', fresh, dm2), '--config', cfgPath]);
var rows = JSON.parse(fs.readFileSync(ledger, 'utf8')).rows;
assert.ok(rows.length >= 3 && rows.every(function (r) { return !r[L.COL.verdict]; }), 'an alert in the DM rejects nothing: ' + JSON.stringify(rows.map(function (r) { return r[7]; })));
assert.ok(!/Took your last reply|NOT APPLIED/.test(d2), 'and is not read as a reply at all');
assert.ok(A.load(rdir).baseline.date === '2026-10-01' && Object.keys(A.load(rdir).alerted).length === 0 && A.load(rdir).pending === null,
  'the next digest rewrites the baseline and starts the alerted record again');

// A digest run with no config file has nowhere to keep a baseline, and writes none into the working directory.
var here = process.cwd(), lone = tmp();
process.chdir(lone);
var loneIn = input('2026-09-30'), loneJson = JSON.parse(fs.readFileSync(loneIn, 'utf8'));
loneJson.self = ME; loneJson.tzOffset = 0; loneJson.spotCheck = 0;
fs.writeFileSync(loneIn, JSON.stringify(loneJson));
try { main([loneIn, '--ledger', path.join(lone, 'lone-ledger.json')]); } finally { process.chdir(here); }
assert.ok(fs.existsSync(path.join(lone, 'lone-ledger.json')), 'the digest itself ran and recorded');
assert.ok(!fs.existsSync(path.join(lone, 'alerts.json')), 'no config, no baseline');

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
['Slack may not notify you', 'routine notification after every check', 'more than two hours late is skipped', 'for a priority',
 'Saying yes edits your existing scheduled Open Loops task'].forEach(function (p) { assert.ok(asked.indexOf(p) > -1, 'consent says: ' + p); });
assert.ok(!/desktop notification from the Claude app|count only|count-only/i.test(asked), 'the unverified ping is not promised');
assert.ok(/Midday alerts on/.test(cli.main(['--consent', '--yes', '--config', ccfg])));
assert.ok(A.consent(JSON.parse(fs.readFileSync(ccfg, 'utf8'))), '--yes records');
assert.ok(/Alerts on at 09:00, 12:00, 15:00/.test(cli.main(['--status', '--config', ccfg])));
assert.ok(/Recorded/.test(cli.main(['--decline', '--config', ccfg])));
assert.strictEqual(A.consent(JSON.parse(fs.readFileSync(ccfg, 'utf8'))), null, 'declining turns it off');
assert.ok(/declined/.test(cli.main(['--status', '--config', ccfg])));
assert.strictEqual(JSON.parse(fs.readFileSync(ccfg, 'utf8')).you, ME, 'the rest of the config is left as it was');

/* ------------------------------ the offer is not part of a scheduled run ------------------------------ */
var inDigest = skill.slice(skill.indexOf('## Running the digest'), skill.indexOf('## Midday check'));
var inCheck = skill.slice(skill.indexOf('## Midday check'), skill.indexOf('## Scheduling it'));
assert.ok(!/Midday alerts — off unless/.test(inDigest + inCheck), 'a scheduled run never reads the question');
assert.ok(skill.indexOf('Midday alerts — off unless') > skill.indexOf('## Scheduling it'));
assert.ok(/limit=15/.test(skill), 'the DM read is wider when alerts are on');

console.log('alerts: OK');
