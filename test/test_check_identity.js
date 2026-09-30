/* Two people's identities must be the same from one midday check to the next, without a check ever writing the ledger.
 *
 * The bug: a ledger from before identities has no salt. Two people made the same urgent commitment; the 12:00 check alerted both (new items), the
 * alert was confirmed, and the 15:00 check alerted both AGAIN. A check may not write the ledger, so it made a salt in memory, and every check made a
 * different one: the people's keys changed between checks, and the dedupe (by key) never matched.
 * Now a check with no ledger salt uses a salt kept in the checks' own file (alerts.json), only when two people actually share a key.
 * Dates are fixed: 2026-10-01 is a Thursday.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var { main } = require('../slack-run.js');
var alertsCli = require('../tools/alerts.js');
var A = require('../src/alerts.js');

var NL = String.fromCharCode(10), ME = 'alex@example.com';
var at = function (m, d, h) { return (Date.UTC(2026, m - 1, d, h) / 1000).toFixed(6); };
var who = { lena: ['Lena Borg', 'lena@vf.example', 'U0EXAMPLE002'], sam: ['Sam Okafor', 'sam@acme.example', 'U0EXAMPLE003'] };
var banner = function (ts, body, p) { return '=== Message from ' + who[p][0] + ' <' + who[p][1] + '> (' + who[p][2] + ') at ' + ts + ' UTC ===' + NL + 'Message TS: ' + ts + NL + body; };
var DECK = "I'll send the deck by Sep 30.";
var ROADMAP = "I'll send the roadmap Friday Oct 2.";

var scenario = function (peopleAtCheck) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-checkid-')), cfg = path.join(dir, 'openloops.config.json'), ledger = path.join(dir, 'ledger.json');
  fs.writeFileSync(cfg, JSON.stringify({ you: ME, selfDm: 'U0EXAMPLE001', tzOffset: 0, spotCheck: 0, ledger: ledger, channels: { include: ['#ops'] },
    alerts: { delivery: 'dm', consentedAt: '2026-09-29T20:00:00Z', times: ['12:00', '15:00'] } }));
  var n = 0;
  var input = function (today, chat) {
    var p = path.join(dir, 'in' + (n++) + '.json');
    fs.writeFileSync(p, JSON.stringify({ today: today, conversations: [{ channel: '#ops', members: [], text: chat, complete: true }], dm: { channel: 'D0', text: '' } }));
    return p;
  };
  var baseChat = banner(at(9, 28, 9), ROADMAP, 'lena');
  var checkChat = baseChat + NL + peopleAtCheck.map(function (p, i) { return banner(at(9, 29, 10 + i), DECK, p); }).join(NL);
  var digest = function (today, chat) {
    var out = main([input(today, chat), '--config', cfg]);
    var ref = (out.split(NL)[0].match(/· ref ([0-9a-f]{4})/) || [])[1];
    assert.ok(/^Baseline recorded/.test(alertsCli.main(['--baseline', '--ref', ref, '--config', cfg])));
    return out;
  };
  var check = function (today, slot, now, chat) { return main([input(today, chat), '--config', cfg, '--check', '--slot', slot, '--today', today, '--now', now]); };
  return { dir: dir, cfg: cfg, ledger: ledger, baseChat: baseChat, checkChat: checkChat, digest: digest, check: check };
};
var confirmPending = function (s) {
  var id = A.load(s.dir).pending.id;
  assert.ok(/^Confirmed/.test(alertsCli.main(['--confirm', '--id', id, '--config', s.cfg])));
};
/* A ledger as it was before identities: no salt, no owners, only the address in the who column. */
var makeOld = function (s) {
  var led = JSON.parse(fs.readFileSync(s.ledger, 'utf8'));
  delete led.identitySalt; led.rows.forEach(function (r) { r[8] = ''; });
  fs.writeFileSync(s.ledger, JSON.stringify(led));
};

/* ------------------------------ the regression: two people, two checks, one alert ------------------------------ */
var s = scenario(['lena', 'sam']);
s.digest('2026-09-30', s.baseChat);           // the previous digest: one unrelated, not-yet-due item
makeOld(s);
var ledgerBefore = fs.readFileSync(s.ledger, 'utf8');

var first = s.check('2026-10-01', '12:00', '2026-10-01T12:05', s.checkChat);
assert.ok(/^OPEN LOOPS ALERT — 2026-10-01 12:00/.test(first), 'the 12:00 check alerts: ' + first);
assert.strictEqual((first.match(/send the deck/g) || []).length, 2, 'on both people\'s commitments: ' + first);
assert.ok(/^2 things changed/m.test(first), first);
confirmPending(s);

var second = s.check('2026-10-01', '15:00', '2026-10-01T15:02', s.checkChat);
assert.ok(/^NO ALERT/.test(second), 'the confirmed items are not alerted again at 15:00: ' + second);
var third = s.check('2026-10-01', '15:00', '2026-10-01T15:40', s.checkChat);
assert.ok(/^SKIP|^NO ALERT/.test(third), 'nor on a repeat: ' + third);

assert.strictEqual(fs.readFileSync(s.ledger, 'utf8'), ledgerBefore, 'a check never writes the ledger');
assert.ok(!('identitySalt' in JSON.parse(fs.readFileSync(s.ledger, 'utf8'))), 'and never gives it a salt');
var state = JSON.parse(fs.readFileSync(path.join(s.dir, 'alerts.json'), 'utf8'));
assert.ok(/^[0-9a-f]{32}$/.test(state.identitySalt), 'the salt that keeps the two apart lives in the checks\' own file');
assert.strictEqual(A.checkSalt(s.dir), state.identitySalt, 'and is read back, not remade');
assert.strictEqual(Object.keys(state.alerted).length, 2, 'two confirmed keys');

// The digest owns the ledger: it makes the ledger's salt, and the people are still two.
s.digest('2026-10-01', s.checkChat);
var led = JSON.parse(fs.readFileSync(s.ledger, 'utf8'));
assert.ok(/^[0-9a-f]{32}$/.test(led.identitySalt), 'the evening digest makes the ledger\'s salt');
assert.strictEqual(led.rows.filter(function (r) { return /send the deck/.test(r[6]); }).length, 2, 'two rows, one for each person');
var next = s.check('2026-10-02', '12:00', '2026-10-02T12:05', s.checkChat);
assert.ok(!/send the deck/.test(next), 'and the next day\'s check finds them already in the baseline (the roadmap becoming due is a different item): ' + next);

/* ------------------------------ one person needs no salt, so none is made ------------------------------ */
var one = scenario(['lena']);
one.digest('2026-09-30', one.baseChat); makeOld(one);
var oneAlert = one.check('2026-10-01', '12:00', '2026-10-01T12:05', one.checkChat);
assert.ok(/^OPEN LOOPS ALERT/.test(oneAlert) && (oneAlert.match(/send the deck/g) || []).length === 1, oneAlert);
var oneState = JSON.parse(fs.readFileSync(path.join(one.dir, 'alerts.json'), 'utf8'));
assert.ok(!('identitySalt' in oneState), 'no two people share a key: no salt is made');

/* ------------------------------ a ledger that has its own salt is used as it is ------------------------------ */
var own = scenario(['lena', 'sam']);
own.digest('2026-09-30', own.baseChat);
var ownLedger = fs.readFileSync(own.ledger, 'utf8');
assert.ok(/"identitySalt"/.test(ownLedger));
var ownFirst = own.check('2026-10-01', '12:00', '2026-10-01T12:05', own.checkChat);
assert.ok(/^OPEN LOOPS ALERT/.test(ownFirst)); confirmPending(own);
assert.ok(/^NO ALERT/.test(own.check('2026-10-01', '15:00', '2026-10-01T15:02', own.checkChat)), 'with the ledger\'s salt the two checks agree too');
assert.ok(!('identitySalt' in JSON.parse(fs.readFileSync(path.join(own.dir, 'alerts.json'), 'utf8'))), 'the checks\' own salt is not made when the ledger has one');
assert.strictEqual(fs.readFileSync(own.ledger, 'utf8'), ownLedger, 'and the ledger is untouched');

console.log('check identity: OK');
