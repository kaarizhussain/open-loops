/* Commitments from different people sharing one ledger key.
 *
 * The bug: type|thread|said-date|fnv(sentence) names no person, so two people saying the same sentence in one thread on one day shared
 * one row. The second was shown as "not new", and rejecting one hid both. The design keeps every existing key, digest memo and correction
 * as it is and qualifies a key with a person token only when two people share it:
 *   - a person's key is stable when others disappear, reorder or age out
 *   - a person-qualified row is looked for before the base key is given to anybody
 *   - the token is sha256(ledger salt | who), full length, pseudonymous; `storeText:false` keeps it while scrubbing `who`
 *   - different people never share a key, even if a token collides
 *   - a legacy row with no owner and a correction on it is never handed to whoever appears, even alone
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var loops = require('../src/loops.js');
var L = require('../src/ledger.js');
var I = require('../src/identity.js');
var { fileStore } = require('../src/store.js');
var { main } = require('../slack-run.js');

global.loopKey = loops.loopKey;
global.OWNER = loops.OWNER;
global.LABEL = loops.LABEL;
var SALT = 'a1b2c3d4e5f60718a1b2c3d4e5f60718';
var TOK = function (w) { return I.token(SALT, w); };
var BASE_PARTS = { type: 'owed_to_us', threadId: '1790000000.000100@#ops', said: '2026-09-20', what: "I'll send the deck tomorrow" };
var mk = function (who, extra) { return Object.assign({}, BASE_PARTS, { who: who, subject: '#ops' }, extra || {}); };
var BASE = loops.baseKey(mk('alice@x.com'));
var HEX64 = /^[0-9a-f]{64}$/;
var rowOf = function (rows, key) { return rows.filter(function (r) { return r[0] === key; })[0]; };

/* One run: decide keys, merge, and hand back who-> key, the loops as shown, and what identity reported. */
var run = function (rows, whos, o) {
  o = o || {};
  var ls = whos.map(function (w) { return mk(w); });
  var pairs = (o.extraPairs || []).concat(ls.map(function (l) { return { base: loops.baseKey(l), who: l.who }; }));
  var ident = I.apply(rows, pairs, SALT, o.tokenFn);
  loops.setIdentityResolver(ident.resolve);
  try {
    var keys = {}; ls.forEach(function (l) { keys[l.who] = loops.loopKey(l); });
    var merged = L.mergeLedger(rows, ls, o.today || '2026-09-28', { storeText: o.storeText !== false, identity: { token: o.tokenFn ? function (w) { return o.tokenFn(SALT, w); } : TOK } });
    return { keys: keys, shown: merged.shown, merged: merged, ident: ident, loops: ls };
  } finally { loops.setIdentityResolver(null); }
};
var suffixOf = function (key) { return key.slice(BASE.length + 1); };

/* ------------------------------ a lone person keeps the key it always had ------------------------------ */
var rows = [];
var r1 = run(rows, ['alice@x.com']);
assert.strictEqual(r1.keys['alice@x.com'], BASE, 'nobody shares it: the key is exactly the old one');
assert.strictEqual(rows.length, 1); assert.strictEqual(rows[0][8], TOK('alice@x.com'), 'and the row records whose it is');
assert.ok(HEX64.test(rows[0][8]));

/* ------------------------------ two people, one sentence: two rows ------------------------------ */
rows = [];
var both = run(rows, ['alice@x.com', 'bob@x.com']);
assert.strictEqual(rows.length, 2, 'two rows, not one');
assert.ok(both.keys['alice@x.com'] !== both.keys['bob@x.com']);
[['alice@x.com'], ['bob@x.com']].forEach(function (w) { assert.strictEqual(both.keys[w[0]], BASE + '|' + TOK(w[0]), 'a group: each person gets the full 64-hex token'); });
assert.deepStrictEqual(both.shown.map(function (l) { return l.isNew; }), [true, true], 'both are new');
assert.strictEqual(both.merged.fresh, 2);

// Rejecting one does not hide the other (this was the bug: suppressed 2).
rowOf(rows, both.keys['alice@x.com'])[7] = 'x';
var after = run(rows, ['alice@x.com', 'bob@x.com'], { today: '2026-09-29' });
assert.strictEqual(after.shown.length, 1, 'one is hidden');
assert.strictEqual(after.shown[0].who, 'bob@x.com', 'and it is the one that was rejected');
assert.strictEqual(after.merged.suppressed, 1);

/* ------------------------------ a person's key is stable when others disappear, reorder or age out ------------------------------ */
var kb = both.keys['bob@x.com'], ka = both.keys['alice@x.com'];
assert.strictEqual(run(rows, ['bob@x.com']).keys['bob@x.com'], kb, 'bob alone later: same key, not the bare base key');
assert.strictEqual(run(rows, ['bob@x.com', 'alice@x.com']).keys['bob@x.com'], kb, 'reordered');
assert.strictEqual(run(rows, ['alice@x.com']).keys['alice@x.com'], ka, 'alice alone');
var withCarol = run(rows, ['carol@x.com', 'alice@x.com', 'bob@x.com']);
assert.strictEqual(withCarol.keys['alice@x.com'], ka); assert.strictEqual(withCarol.keys['bob@x.com'], kb);
assert.ok(withCarol.keys['carol@x.com'].indexOf(BASE + '|') === 0 && withCarol.keys['carol@x.com'] !== ka && withCarol.keys['carol@x.com'] !== kb, 'a third person gets a third key');
assert.strictEqual(rows.filter(function (r) { return r[0] === BASE; }).length, 0, 'the bare base key was never given to anyone in a group');

/* ------------------------------ an existing person-qualified row is found before the base key is assigned ------------------------------ */
rows = [[BASE + '|' + TOK('bob@x.com'), '2026-09-20', '2026-09-27', '', 'owed_to_us', 'bob@x.com', "I'll send the deck tomorrow", 'x', TOK('bob@x.com')]];
var solo = run(rows, ['bob@x.com'], { today: '2026-09-28' });
assert.strictEqual(solo.keys['bob@x.com'], BASE + '|' + TOK('bob@x.com'), 'Bob alone, with only his qualified row on file: his key, not the bare one');
assert.strictEqual(solo.shown.length, 0, 'and his rejection still applies');
assert.strictEqual(rows.length, 1);

/* ------------------------------ a base row owned by somebody else is not handed over ------------------------------ */
rows = [[BASE, '2026-09-20', '2026-09-27', '', 'owed_to_us', 'alice@x.com', "I'll send the deck tomorrow", 'x']];     // written before identities: who is the address
var owned = run(rows, ['alice@x.com', 'bob@x.com']);
assert.strictEqual(owned.keys['alice@x.com'], BASE, 'alice keeps the row that is hers, correction and all');
assert.strictEqual(owned.keys['bob@x.com'], BASE + '|' + TOK('bob@x.com'), 'bob gets his own, and is shown');
assert.deepStrictEqual(owned.shown.map(function (l) { return l.who; }), ['bob@x.com'], 'alice\'s rejection hides alice only');
assert.strictEqual(rows[0][8], TOK('alice@x.com'), 'and the old row now records its owner as a token');
// The same, with Bob alone: still not Alice's correction.
rows = [[BASE, '2026-09-20', '2026-09-27', '', 'owed_to_us', 'alice@x.com', "I'll send the deck tomorrow", 'x']];
var bobOnly = run(rows, ['bob@x.com']);
assert.strictEqual(bobOnly.keys['bob@x.com'], BASE + '|' + TOK('bob@x.com'), 'Bob alone does not inherit a row that is Alice\'s');
assert.strictEqual(bobOnly.shown.length, 1);
assert.strictEqual(rows[0][7], 'x', 'Alice\'s row is untouched');

/* ------------------------------ a legacy row with no owner never transfers its correction ------------------------------ */
var legacy = function () { return [[BASE, '2026-09-20', '2026-09-27', '', 'owed_to_us', '', '', 'x']]; };       // storeText:false era: no who
rows = legacy();
var lone = run(rows, ['bob@x.com']);
assert.strictEqual(lone.shown.length, 1, 'one person appears: the correction is NOT applied to them');
assert.strictEqual(lone.shown[0].isNew, true);
assert.deepStrictEqual(lone.ident.unowned, [{ base: BASE, people: 1 }], 'and it is reported as an owner nobody can confirm');
assert.ok(rows.some(function (r) { return r[0] === BASE + '|ambiguous' && r[7] === 'x'; }), 'the record is kept, inert, with its correction');
assert.ok(!rows.some(function (r) { return r[0] === BASE && r[7] === 'x'; }), 'and nothing live carries it');
// Two people: the same, counted.
rows = legacy();
var two = run(rows, ['alice@x.com', 'bob@x.com']);
assert.strictEqual(two.shown.length, 2); assert.deepStrictEqual(two.ident.unowned, [{ base: BASE, people: 2 }]);
assert.ok(two.keys['alice@x.com'] !== two.keys['bob@x.com'] && two.keys['alice@x.com'] !== BASE);
// Closed items count as matches: a person whose commitment already closed is still a person who matches.
rows = legacy();
var withClosed = run(rows, ['bob@x.com'], { extraPairs: [{ base: BASE, who: 'alice@x.com' }] });
assert.deepStrictEqual(withClosed.ident.unowned, [{ base: BASE, people: 2 }], 'a closed commitment by a second person is counted');
assert.ok(withClosed.keys['bob@x.com'].indexOf(BASE + '|') === 0, 'so Bob is qualified, not given the bare key');
// No correction on it: nothing to misapply, so a lone person continues the row; a group does not share it.
rows = legacy(); rows[0][7] = '';
var cont = run(rows, ['bob@x.com']);
assert.strictEqual(cont.keys['bob@x.com'], BASE, 'a lone person continues an uncorrected ownerless row'); assert.strictEqual(cont.ident.unowned.length, 0); assert.strictEqual(cont.shown[0].isNew, false);
assert.strictEqual(rows[0][8], TOK('bob@x.com'), 'and it then records its owner');
rows = legacy(); rows[0][7] = '';
var grp = run(rows, ['alice@x.com', 'bob@x.com']);
assert.ok(grp.keys['alice@x.com'] !== BASE && grp.keys['bob@x.com'] !== BASE && grp.ident.unowned.length === 0, 'an uncorrected ownerless row is set aside quietly for a group: there is no correction to report');
// A "known already" mark is a correction too.
rows = legacy(); rows[0][7] = 'k';
assert.strictEqual(run(rows, ['bob@x.com']).ident.unowned.length, 1);
// A placeholder a reply created belongs to whoever fills it; with two people it cannot be told, and is not guessed.
rows = [[BASE, '2026-09-28', '2026-09-28', '', 'owed_to_us', '', '', 'x', '~']];
var ph = run(rows, ['bob@x.com']);
assert.strictEqual(ph.keys['bob@x.com'], BASE); assert.strictEqual(ph.shown.length, 0, 'a lone person fills the placeholder: the reply was about their item');
assert.strictEqual(rows[0][8], TOK('bob@x.com'));
rows = [[BASE, '2026-09-28', '2026-09-28', '', 'owed_to_us', '', '', 'x', '~']];
assert.strictEqual(run(rows, ['alice@x.com', 'bob@x.com']).shown.length, 2, 'two people: the placeholder is set aside, nobody is rejected on a guess');

/* ------------------------------ which commitments count as matches: open ones and closed ones, under every key variant ------------------------------ */
var closedLoop = Object.assign(mk('alice@x.com'), { type: 'owed_by_us', openType: 'owed_to_us', byUs: true });
var eventLoop = { type: 'unprepped_meeting', eventId: 'e1', who: 'a@x.com' };
var pf = I.pairsFrom({ open: [mk('bob@x.com'), eventLoop], closed: [closedLoop, eventLoop] }, loops.baseKey);
assert.deepStrictEqual(pf.map(function (p) { return p.who; }), ['bob@x.com', 'alice@x.com', 'alice@x.com'], 'open, closed, and the closed one\'s second key variant; never a meeting');
assert.strictEqual(pf[1].base, loops.baseKey(Object.assign({}, closedLoop, { type: 'owed_to_us' })), 'a closed item is looked up under the type it was opened as');
assert.strictEqual(pf[2].base, loops.baseKey(Object.assign({}, closedLoop, { type: 'agreed_unscheduled' })));

/* ------------------------------ tokens: one-way, per ledger, and never merging two people ------------------------------ */
assert.ok(HEX64.test(I.token(SALT, 'a@b.co')));
assert.strictEqual(I.token(SALT, ' A@B.co '), I.token(SALT, 'a@b.co'), 'case and padding do not make a second person');
assert.notStrictEqual(I.token(SALT, 'a@b.co'), I.token('another salt', 'a@b.co'), 'another ledger, another token');
assert.ok(I.token(SALT, 'a@b.co').indexOf('a@b.co') < 0);
// A collision (forced): the two are still two keys, and stay two.
var collide = function () { return 'c'.repeat(64); };
rows = [];
var col = run(rows, ['alice@x.com', 'bob@x.com'], { tokenFn: collide });
var ckeys = [col.keys['alice@x.com'], col.keys['bob@x.com']];
assert.notStrictEqual(ckeys[0], ckeys[1], 'different people never share a key, even if their tokens are equal');
assert.ok(ckeys.every(function (k) { return k.indexOf(BASE + '|' + collide()) === 0; }) && ckeys.some(function (k) { return /~2$/.test(k); }));
assert.strictEqual(rows.length, 2);
var again = run(rows, ['bob@x.com', 'alice@x.com'], { tokenFn: collide });
assert.deepStrictEqual([again.keys['alice@x.com'], again.keys['bob@x.com']], ckeys, 'and the same two keys the next run, in either order');

/* ------------------------------ storeText:false keeps people apart and stores no address ------------------------------ */
rows = [];
var st1 = run(rows, ['alice@x.com', 'bob@x.com'], { storeText: false });
assert.ok(rows.every(function (r) { return r[5] === '' && r[6] === ''; }), 'no who, no what');
assert.ok(rows.every(function (r) { return HEX64.test(r[8]); }), 'but every row says whose it is, by token');
assert.ok(!JSON.stringify(rows).match(/@x\.com/), 'no address anywhere in the rows');
rowOf(rows, st1.keys['alice@x.com'])[7] = 'x';
var st2 = run(rows, ['alice@x.com', 'bob@x.com'], { storeText: false, today: '2026-09-29' });
assert.deepStrictEqual(st2.shown.map(function (l) { return l.who; }), ['bob@x.com'], 'a rejection hides only its own person, with no text kept');
assert.strictEqual(run(rows, ['bob@x.com'], { storeText: false }).keys['bob@x.com'], st1.keys['bob@x.com'], 'and stays stable');
// Turning text storage off later: an old row's owner becomes a token before the address is scrubbed.
rows = [[BASE, '2026-09-20', '2026-09-27', '', 'owed_to_us', 'alice@x.com', "I'll send the deck tomorrow", 'x']];
var off = run(rows, ['alice@x.com', 'bob@x.com'], { storeText: false });
assert.strictEqual(rows[0][5], ''); assert.strictEqual(rows[0][8], TOK('alice@x.com'));
assert.strictEqual(off.keys['alice@x.com'], BASE, 'Alice still owns her corrected row after the scrub');
assert.deepStrictEqual(off.shown.map(function (l) { return l.who; }), ['bob@x.com']);

/* ------------------------------ the salt: one per ledger, kept through reruns, snapshots, copies and scrubbing ------------------------------ */
var d = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-ident-')), file = path.join(d, 'l.json');
var s1 = fileStore(file);
var salt1 = s1.identitySalt();
assert.ok(/^[0-9a-f]{32}$/.test(salt1)); assert.strictEqual(s1.identitySalt(), salt1, 'made once');
s1.writeLedger([[BASE, '2026-09-20', '2026-09-27', '', 'owed_to_us', '', '', 'x', I.token(salt1, 'a@b.co')]]);
assert.strictEqual(fileStore(file).identitySalt(), salt1, 'kept in the ledger, so a reopened ledger has the same one');
var copy = path.join(d, 'backup.json'); fs.copyFileSync(file, copy);
assert.strictEqual(fileStore(copy).identitySalt(), salt1, 'and a backup carries it');
// A same-day re-run rolls the ledger back to a snapshot taken before the salt existed: the salt must survive that.
var f2 = path.join(d, 'l2.json'); var a = fileStore(f2); a.beginRun('2026-09-28'); var s2 = a.identitySalt(); a.writeLedger([]);
var b = fileStore(f2); b.beginRun('2026-09-28');
assert.strictEqual(b.identitySalt(), s2, 'a re-run does not unmake the salt');
// Text scrubbing keeps it, and turns an address into a token first.
var f3 = path.join(d, 'l3.json'); var c = fileStore(f3); var s3 = c.identitySalt();
c.writeLedger([[BASE, '2026-09-20', '2026-09-27', '', 'owed_to_us', 'alice@x.com', 'what', 'x']]);
var c2 = fileStore(f3); c2.dropText(); c2.writeLedger(c2.readLedger().map(function (r) { return r; }));
var scrubbed = JSON.parse(fs.readFileSync(f3, 'utf8'));
assert.strictEqual(scrubbed.identitySalt, s3, 'the scrub keeps the salt');
var sr = c2.readLedger()[0]; assert.strictEqual(sr[5], ''); assert.strictEqual(sr[6], ''); assert.strictEqual(sr[8], I.token(s3, 'alice@x.com'), 'and keeps who as a token');
// A ledger that holds person tokens and has lost its salt is an error, not a fresh start.
var f4 = path.join(d, 'l4.json'); var dd = JSON.parse(fs.readFileSync(file, 'utf8')); delete dd.identitySalt; fs.writeFileSync(f4, JSON.stringify(dd));
assert.throws(function () { fileStore(f4).identitySalt(); }, /holds person identifiers but no identity salt/);
// An old ledger with no tokens and no salt simply gets one.
var f5 = path.join(d, 'l5.json'); fs.writeFileSync(f5, JSON.stringify({ rows: [[BASE, '2026-09-20', '2026-09-27', '', 'owed_to_us', 'a@b.co', 'w', '']], digests: {}, refs: {}, seen: [], learned: [], audit: { checked: 0, missed: [], asked: {} } }));
assert.ok(/^[0-9a-f]{32}$/.test(fileStore(f5).identitySalt()));

/* ------------------------------ legacy lookup: channel qualification and person qualification stay compatible ------------------------------ */
var chan = loops.baseKey(mk('alice@x.com')), tokK = chan + '|' + TOK('alice@x.com');
var bare = 'owed_to_us|1790000000.000100|2026-09-20|' + chan.split('|')[3];
assert.strictEqual(loops.legacyKey(chan), bare, 'a channel-qualified key maps to the bare-root key, as before');
assert.strictEqual(loops.legacyKey(tokK), bare, 'so does a person-qualified one: the token comes off first');
assert.strictEqual(loops.legacyKey(chan + '|' + TOK('x') + '~2'), bare, 'including a collision-counted one');
assert.strictEqual(loops.legacyKey(bare), bare, 'a bare key is unchanged');
var nonNumeric = 'owed_by_us|#ops@#ops|2026-09-20|deadbeef';
assert.strictEqual(loops.legacyKey(nonNumeric + '|' + TOK('x')), nonNumeric + '|' + TOK('x'), 'a key with no thread timestamp is not turned into another live row\'s key');
assert.strictEqual(loops.legacyKey('meeting|evt1'), 'meeting|evt1');
// Both people map to one bare legacy row: with no known owner and a correction, it is set aside; nobody receives it.
var legacyRows = [[bare, '2026-09-20', '2026-09-27', '', 'owed_to_us', '', '', 'x']];
var rec = L.reconcileLegacy(legacyRows, [{ key: chan + '|' + TOK('alice@x.com'), channel: '#ops', who: 'alice@x.com' }, { key: chan + '|' + TOK('bob@x.com'), channel: '#ops', who: 'bob@x.com' }],
  { legacyKey: loops.legacyKey, readsOk: true, owner: function (r) { return I.ownerOf(r, SALT); }, tokenOf: function (w) { return I.token(SALT, w); } });
assert.deepStrictEqual(rec.unowned, [{ legacy: bare, people: 2 }]); assert.strictEqual(legacyRows[0][0], bare + '|ambiguous'); assert.deepStrictEqual(rec.renames, {});
// One person, no owner, a correction: still not transferred.
legacyRows = [[bare, '2026-09-20', '2026-09-27', '', 'owed_to_us', '', '', 'x']];
rec = L.reconcileLegacy(legacyRows, [{ key: chan, channel: '#ops', who: 'bob@x.com' }], { legacyKey: loops.legacyKey, readsOk: true, owner: function (r) { return I.ownerOf(r, SALT); }, tokenOf: function (w) { return I.token(SALT, w); } });
assert.deepStrictEqual(rec.unowned, [{ legacy: bare, people: 1 }]); assert.deepStrictEqual(rec.renames, {}, 'not adopted');
// The owner is known and it is the one person now: adopted, as before. Known and somebody else's: left alone.
legacyRows = [[bare, '2026-09-20', '2026-09-27', '', 'owed_to_us', 'bob@x.com', 'w', 'x']];
rec = L.reconcileLegacy(legacyRows, [{ key: chan, channel: '#ops', who: 'bob@x.com' }], { legacyKey: loops.legacyKey, readsOk: true, owner: function (r) { return I.ownerOf(r, SALT); }, tokenOf: function (w) { return I.token(SALT, w); } });
assert.strictEqual(legacyRows[0][0], chan, 'the owner\'s own commitment takes the record'); assert.strictEqual(rec.unowned.length, 0);
legacyRows = [[bare, '2026-09-20', '2026-09-27', '', 'owed_to_us', 'alice@x.com', 'w', 'x']];
rec = L.reconcileLegacy(legacyRows, [{ key: chan, channel: '#ops', who: 'bob@x.com' }], { legacyKey: loops.legacyKey, readsOk: true, owner: function (r) { return I.ownerOf(r, SALT); }, tokenOf: function (w) { return I.token(SALT, w); } });
assert.strictEqual(legacyRows[0][0], bare, 'alice\'s record stays alice\'s'); assert.ok(rec.deferred[bare], 'and is kept out of "cleared"');
// Without ownership options (every other caller) nothing changes.
legacyRows = [[bare, '2026-09-20', '2026-09-27', '', 'owed_to_us', '', '', 'x']];
rec = L.reconcileLegacy(legacyRows, [{ key: chan, channel: '#ops' }], { legacyKey: loops.legacyKey, readsOk: true });
assert.strictEqual(legacyRows[0][0], chan, 'callers that do not pass ownership behave exactly as before');

/* ------------------------------ meetings and untouched rows ------------------------------ */
var meet = { type: 'unprepped_meeting', eventId: 'evt1', who: 'a@x.com' };
assert.strictEqual(run([], ['a@x.com'], { extraPairs: [] }).keys['a@x.com'].length > 0, true);
loops.setIdentityResolver(function () { return 'WRONG'; });
assert.strictEqual(loops.loopKey(meet), 'unprepped_meeting|evt1', 'a meeting key never names a person');
loops.setIdentityResolver(null);
assert.strictEqual(loops.loopKey(mk('alice@x.com')), BASE, 'with no resolver every key is the old one');

/* ------------------------------ the digest: the approved warnings ------------------------------ */
var dg = require('../src/digest.js');
var base = { today: '2026-10-01', source: 'slack', messages: [{}], events: [], result: { open: [], closed: [], dark: 0 }, briefs: [], ledger: { shown: [], gone: [] }, marked: 0,
  read: { threads: 2, unread: [], shortRead: [], skipped: 0, windowDays: 21 } };
var text = function (over) { return dg.render(Object.assign({}, base, over)); };
var W1 = 'NOT CONFIRMED — an older tracking record has no recorded owner, so it was kept separately. Any earlier correction was not applied to the current commitment. Reply to the current digest if that correction still applies.';
var W3 = 'NOT MATCHED — an older tracking record matches commitments from 3 different people, and its owner is unknown. Any earlier correction was applied to none of them. Reply to the current digest to correct the one you meant.';
var W2 = 'NOT APPLIED — this reply refers to an older tracking record whose owner cannot be confirmed. Reply under the current digest to correct the item you mean.';
assert.ok(text({ ownerUnknown: [{ base: BASE, people: 1 }] }).indexOf(W1) > -1, 'one person: owner unknown, no claim that several match');
assert.ok(text({ ownerUnknown: [{ base: BASE, people: 3 }] }).indexOf(W3) > -1, 'more than two people: the real count');
assert.ok(!/matches commitments from/.test(text({ ownerUnknown: [{ base: BASE, people: 1 }] })) && !/NOT CONFIRMED/.test(text({ ownerUnknown: [{ base: BASE, people: 2 }] })));
assert.ok(text({ inertReplies: 1 }).indexOf(W2) > -1, 'a reply to an inert record');
assert.ok(!/matches multiple commitments/.test(text({ inertReplies: 1 })), 'and does not say several commitments match');
assert.ok(/\n1 read warning — in the thread\./.test(text({ inertReplies: 1 }).split('-- thread --')[0]), 'counted in the brief');
assert.ok(!/NOT CONFIRMED|NOT MATCHED|NOT APPLIED — this reply/.test(text({})), 'and absent when there is nothing to say');

/* ------------------------------ end to end through the runner: two people, one sentence ------------------------------ */
var NL = String.fromCharCode(10), ME = 'alex@example.com';
var at = function (m, dd, h) { return (Date.UTC(2026, m - 1, dd, h) / 1000).toFixed(6); };
var banner = function (ts, body, who) {
  var p = who === 'lena' ? ['Lena Borg', 'lena@vf.example', 'U0EXAMPLE002'] : who === 'sam' ? ['Sam Okafor', 'sam@acme.example', 'U0EXAMPLE003'] : ['Alex Rivera', ME, 'U0EXAMPLE001'];
  return '=== Message from ' + p[0] + ' <' + p[1] + '> (' + p[2] + ') at ' + ts + ' UTC ===' + NL + 'Message TS: ' + ts + NL + body;
};
var e2e = function (storeText) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-ident-e2e-')), cfg = path.join(dir, 'c.json'), ledger = path.join(dir, 'l.json');
  fs.writeFileSync(cfg, JSON.stringify({ you: ME, selfDm: 'U0EXAMPLE001', tzOffset: 0, spotCheck: 0, ledger: ledger, storeText: storeText, channels: { include: ['#ops'] } }));
  var chat = banner(at(9, 30, 10), "I'll send the deck tomorrow.", 'lena') + NL + banner(at(9, 30, 11), "I'll send the deck tomorrow.", 'sam');
  var mkIn = function (today, extra) {
    var p = path.join(dir, 'i-' + today + '-' + Object.keys(extra || {}).join('_') + '.json');
    fs.writeFileSync(p, JSON.stringify(Object.assign({ today: today, conversations: [{ channel: '#ops', members: [], text: chat, complete: true }], dm: { channel: 'D0', text: '' } }, extra || {}))); return p;
  };
  var d1 = main([mkIn('2026-10-01'), '--config', cfg]);
  var items = function (t) { return t.split(NL).filter(function (l) { return /^ ?\d+ {2}/.test(l); }).map(function (l) { return l.replace(/\s+/g, ' ').trim(); }); };
  assert.ok(/2 open/.test(d1), 'both people\'s promises are on the list: ' + d1.split(NL).slice(0, 4).join(' / '));
  var first = items(d1.split('-- thread --')[0])[0];
  var rejectedPerson = /Lena/.test(first) ? 'Lena' : /Sam/.test(first) ? 'Sam' : null;
  assert.ok(rejectedPerson, 'item 1 is one of them: ' + first);
  var ref = (d1.split(NL)[0].match(/· ref ([0-9a-f]{4})/) || [])[1], ts1 = at(10, 1, 22);
  var dgMsg = banner(ts1, '```' + NL + d1 + NL + '```');
  var d2 = main([mkIn('2026-10-02', { dm: { channel: 'D0', text: '' }, dmThread: [{ root: ts1, text: dgMsg + NL + banner(at(10, 2, 9), '1') }] }), '--config', cfg]);
  assert.ok(/Took your last reply — 1 marked not real/.test(d2), d2.split(NL).slice(0, 5).join(' / '));
  var left = items(d2.split('-- thread --')[0]).join(' | ');
  assert.ok(/1 open/.test(d2), 'one item is left: ' + left);
  assert.ok(left.indexOf(rejectedPerson === 'Lena' ? 'Sam' : 'Lena') > -1 && left.indexOf(rejectedPerson) < 0, 'and it is the other person\'s: ' + left);
  var rows2 = JSON.parse(fs.readFileSync(ledger, 'utf8')).rows;
  assert.strictEqual(rows2.length, 2); assert.ok(rows2.every(function (r) { return HEX64.test(r[8]); }));
  if (storeText === false) assert.ok(!/lena@|sam@/.test(fs.readFileSync(ledger, 'utf8')), 'no address in a storeText:false ledger');
  return { d2: d2, rows: rows2 };
};
e2e(true); e2e(false);

/* ------------------------------ through the runner: a correction with no owner is kept apart and said so ------------------------------ */
(function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-ident-legacy-')), cfg = path.join(dir, 'c.json'), ledger = path.join(dir, 'l.json');
  fs.writeFileSync(cfg, JSON.stringify({ you: ME, selfDm: 'U0EXAMPLE001', tzOffset: 0, spotCheck: 0, ledger: ledger, channels: { include: ['#ops'] } }));
  var chat = banner(at(9, 30, 10), "I'll send the deck tomorrow.", 'lena');
  var mkIn = function (today, extra) {
    var p = path.join(dir, 'i-' + today + '-' + Object.keys(extra || {}).join('_') + '.json');
    fs.writeFileSync(p, JSON.stringify(Object.assign({ today: today, conversations: [{ channel: '#ops', members: [], text: chat, complete: true }], dm: { channel: 'D0', text: '' } }, extra || {}))); return p;
  };
  var d1 = main([mkIn('2026-10-01'), '--config', cfg]);
  var snapshot = fs.readFileSync(ledger, 'utf8');
  // The row as an older ledger would have it: no owner recorded, and the reader had already rejected it.
  var disown = function (verdict) {
    var led = JSON.parse(snapshot); led.rows.forEach(function (r) { r[5] = ''; r[6] = ''; r[7] = verdict; r[8] = ''; }); fs.writeFileSync(ledger, JSON.stringify(led));
  };
  disown('x');
  var d2 = main([mkIn('2026-10-02'), '--config', cfg]);
  assert.ok(d2.indexOf(W1) > -1, 'the ownerless correction is reported: ' + d2.split(NL).slice(0, 6).join(' / '));
  assert.ok(/1 open/.test(d2), 'and the current commitment is shown, not hidden by a correction that may be somebody else\'s');
  var led2 = JSON.parse(fs.readFileSync(ledger, 'utf8'));
  assert.ok(led2.rows.some(function (r) { return /\|ambiguous$/.test(r[0]) && r[7] === 'x'; }), 'the record is kept, with its correction');
  assert.ok(led2.rows.some(function (r) { return !/\|ambiguous$/.test(r[0]) && r[7] === '' && HEX64.test(r[8]); }), 'and the commitment has a fresh row that names its owner');
  assert.ok(d2.indexOf('NOT MATCHED') < 0, 'one person: not "different people"');
  // A reply typed under the older digest lands on the inert record: it is reported, and applied to no one.
  fs.writeFileSync(ledger, snapshot); disown('');
  var ref = (d1.split(NL)[0].match(/· ref ([0-9a-f]{4})/) || [])[1], ts1 = at(10, 1, 22);
  var d3 = main([mkIn('2026-10-03', { dm: { channel: 'D0', text: '' }, dmThread: [{ root: ts1, text: banner(ts1, '```' + NL + d1 + NL + '```') + NL + banner(at(10, 2, 9), '1') }] }), '--config', cfg]);
  assert.ok(d3.indexOf(W2) > -1, 'a reply to a record whose owner cannot be confirmed: ' + d3.split(NL).slice(0, 8).join(' / '));
  assert.ok(!/matches multiple commitments/.test(d3), 'one person matches, so it does not say several do');
  assert.ok(/1 open/.test(d3) && !/Took your last reply/.test(d3), 'the reply rejected nothing');
})();

assert.strictEqual(loops.loopKey(mk('alice@x.com')), BASE, 'the runner leaves no identity resolver behind for the next run in this process');
// Not even when a run fails after the resolver was set: the last call is the one that clears it.
(function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-ident-fail-')), cfg = path.join(dir, 'c.json'), inp = path.join(dir, 'i.json');
  fs.writeFileSync(cfg, JSON.stringify({ you: ME, selfDm: 'U0EXAMPLE001', tzOffset: 0, spotCheck: 0, ledger: path.join(dir, 'l.json'), channels: { include: ['#ops'] } }));
  fs.writeFileSync(inp, JSON.stringify({ today: '2026-10-01', conversations: [{ channel: '#ops', members: [], text: banner(at(9, 30, 10), "I'll send the deck tomorrow.", 'lena'), complete: true }], dm: { channel: 'D0', text: '' } }));
  var dg2 = require('../src/digest.js'), realRender = dg2.render, realSet = loops.setIdentityResolver, calls = [];
  dg2.render = function () { throw new Error('boom'); };
  loops.setIdentityResolver = function (f) { calls.push(f); return realSet(f); };
  try { assert.throws(function () { main([inp, '--config', cfg, '--dry']); }, /boom/); }
  finally { dg2.render = realRender; loops.setIdentityResolver = realSet; }
  assert.ok(calls.length >= 2 && typeof calls[0] === 'function' && calls[calls.length - 1] === null, 'set during the run, cleared when it threw: ' + calls.map(function (c) { return typeof c; }).join(','));
})();
// A placeholder row a reply creates is marked as belonging to whoever fills it.
assert.strictEqual(L.placeholderRow(BASE, '2026-09-28')[8], '~');
// A legacy row whose person is absent this run: turning text storage off must not lose whose it was.
rows = [[BASE, '2026-09-20', '2026-09-27', '', 'owed_to_us', 'alice@x.com', "I'll send the deck tomorrow", 'x']];
run(rows, ['bob@x.com'], { storeText: false });
assert.strictEqual(rows[0][5], ''); assert.strictEqual(rows[0][8], TOK('alice@x.com'), 'Alice\'s row still says it is Alice\'s after the address was scrubbed, though she was not in this read');

console.log('identity keys: OK');
