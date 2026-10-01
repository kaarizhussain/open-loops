/* Regression tests for the 2026-09-30 review: silent loss, silent privacy failures, alert
 * state, and the live-robustness gaps. Each block failed before its fix. */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var { main } = require('../slack-run.js');
global.loopKey = require('../src/loops.js').loopKey;

var ME = 'you@example.com';
var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openloops-hard-'));
var at = function (y, mo, d, h) { return (Date.UTC(y, mo - 1, d, h) / 1000).toFixed(6); };
var msg = function (name, email, uid, ts, body) {
  return ['=== Message from ' + name + ' <' + email + '> (' + uid + ') at ' + ts + ' UTC ===',
          'Message TS: ' + ts, body].join('\n');
};
var me = function (ts, body) { return msg('Alex Rivera', ME, 'U0EXAMPLE001', ts, body); };
var them = msg;
var n = 0;
var write = function (o) { var p = path.join(dir, 'in' + (n++) + '.json'); fs.writeFileSync(p, JSON.stringify(o)); return p; };
var threadRead = function (parentTs, parentBody, replies) {
  var who = 'From: Alex Rivera <' + ME + '> (U0EXAMPLE001)';
  var out = ['=== THREAD PARENT MESSAGE ===', who, 'Time: 2026-09-01 18:00:00 UTC', 'Message TS: ' + parentTs,
             parentBody, '', '=== THREAD REPLIES (' + replies.length + ' total) ===', ''];
  replies.forEach(function (r, i) {
    out.push('--- Reply ' + (i + 1) + ' of ' + replies.length + ' ---', who,
             'Time: 2026-09-01 19:00:00 UTC', 'Message TS: ' + r[0], r[1], '');
  });
  return out.join('\n');
};
var base = function (today) {
  return {
    self: ME, today: today, tzOffset: 0,
    conversations: [
      { channel: '#vector-freight', members: ['lena@vectorfreight.com'], text: [
        them('Lena Borg', 'lena@vectorfreight.com', 'U01', at(2026, 8, 20, 10),
          "We'll get the revised contract back to you Friday Aug 28."),
        me(at(2026, 8, 21, 9), 'Perfect, thanks Lena.')].join('\n') },
      { channel: '#halcyon', members: ['sana@halcyon.io'], text: [
        me(at(2026, 8, 25, 11), "I'll put together a scope doc and send it Wednesday."),
        them('Sana Iyer', 'sana@halcyon.io', 'U03', at(2026, 8, 25, 12), 'Great, looking forward to it.')].join('\n') }
    ],
    dm: { channel: 'D0', text: '' }
  };
};
var NOT_READ = function (label) { return 'NOT READ — ' + label + ' could not be parsed. Its tracked items remain open but were not verified this run.'; };
var rowsOf = function (f) { return JSON.parse(fs.readFileSync(f, 'utf8')).rows; };
var verdicts = function (f) { return rowsOf(f).map(function (r) { return r[7] || ''; }).join(','); };

/* ---- 1. A details message that lost its header line is not a reply ---- */
(function () {
  var led = path.join(dir, 'headerless.json');
  var first = main([write(base('2026-09-01')), '--ledger', led]);
  var brief = first.split('-- thread --')[0].trim(), details = first.split('-- thread --')[1].trim();
  var headless = details.split('\n').slice(1).join('\n');          // header line gone
  var ts = at(2026, 9, 1, 18);
  var next = base('2026-09-02');
  next.dm = { channel: 'D0', text: me(ts, '```\n' + brief + '\n```') };
  next.dmThread = { root: ts, text: threadRead(ts, '```\n' + brief + '\n```',
    [[ts.replace(/\.0+$/, '.000100'), '```\n' + headless + '\n```']]) };
  var out = main([write(next), '--ledger', led]);
  assert.ok(!/Took your last reply/.test(out), 'a headerless details message is not read as a rejection');
  assert.ok(!/x/.test(verdicts(led)), 'and no item is marked wrong by it: ' + verdicts(led));
})();

/* ---- 2. Scope settings fail closed: a config that cannot be read as written reads nothing ---- */
var cfgFile = function (extra) {
  var p = path.join(dir, 'cfg' + (n++) + '.json');
  fs.writeFileSync(p, JSON.stringify(Object.assign({ you: ME }, extra)));
  return p;
};
var readsHalcyon = function (cfgExtra, inputEdit) {
  var i = base('2026-09-01'); if (inputEdit) inputEdit(i);
  return main([write(i), '--config', cfgFile(cfgExtra), '--ledger', path.join(dir, 'scope' + (n++) + '.json'), '--dry']);
};
[
  ['channels as a list', { channels: ['#halcyon'] }],
  ['channels null', { channels: null }],
  ['misspelled key', { channels: { excludes: ['#halcyon'] } }],
  ['a string where a list belongs', { channels: { exclude: '#halcyon' } }],
  ['exclude at the top level', { exclude: ['#halcyon'] }],
  ['include at the top level', { include: ['#halcyon'] }]
].forEach(function (c) {
  assert.throws(function () { readsHalcyon(c[1]); }, /channels|exclude|include/i, c[0] + ' must stop the run, not read every channel');
});
assert.throws(function () { readsHalcyon({}, function (i) { i.scope = { exclude: '#halcyon' }; }); }, /scope/i,
  "a run's own malformed scope stops the run too");
assert.ok(readsHalcyon({ channels: { exclude: ['#halcyon'] } }).indexOf('scope doc') === -1, 'a valid exclude still excludes');
assert.ok(readsHalcyon({ channels: { only: ['#vector-freight'] } }).indexOf('scope doc') === -1, "'only' is still accepted");
assert.ok(readsHalcyon({ channels: { include: [], exclude: [] } }).indexOf('scope doc') > -1, 'and an empty scope reads everything');

/* ---- 3. Nothing read is never "Nothing outstanding. Genuinely" ---- */
var quiet = function (edit, cfgExtra) {
  var i = base('2026-09-02'); edit(i);
  return main([write(i), '--config', cfgFile(cfgExtra || {}), '--ledger', path.join(dir, 'blind.json')]);
};
var seed = main([write(base('2026-09-01')), '--config', cfgFile({}), '--ledger', path.join(dir, 'blind.json')]);
assert.ok(/scope doc/.test(seed), 'precondition: the ledger tracks items');
var none = quiet(function (i) { i.conversations = []; });
var SENTENCE = 'This does not establish that the day was quiet.', TAIL = 'Treat the empty list below as unknown rather than clear.';
assert.ok(none.indexOf('READ NOTHING — no conversation was handed over to read. ' + SENTENCE + ' ' + TAIL) > -1, 'the exact wording: ' + none.split(String.fromCharCode(10))[3]);
assert.ok(none.indexOf('not a quiet day') === -1);
assert.ok(/READ NOTHING/.test(none) && !/Genuinely/.test(none), 'no conversations handed over: ' + none.split(String.fromCharCode(10)).slice(0, 4).join(' | '));
var noneKey = quiet(function (i) { delete i.conversations; });
assert.ok(/READ NOTHING/.test(noneKey) && !/Genuinely/.test(noneKey), 'no conversations key at all');
var scoped = quiet(function () {}, { channels: { include: ['#does-not-exist'] } });
assert.ok(scoped.indexOf(SENTENCE + ' ' + TAIL) > -1, 'the scope variant says it exactly too');
assert.ok(/READ NOTHING/.test(scoped) && !/Genuinely/.test(scoped) && /skipped/.test(scoped.split(String.fromCharCode(10)).slice(0, 4).join(' ')),
  'every conversation skipped by scope says so: ' + scoped.split(String.fromCharCode(10)).slice(0, 4).join(' | '));

/* ---- 4. A ledger that parses but is the wrong shape is refused, not treated as empty ---- */
['[]', '{}', '""', 'null', '{"Rows":[]}', '{"rows":{"a":1}}', '{"rows":[null]}', '{"rows":["x"]}'].forEach(function (raw) {
  var f = path.join(dir, 'shape' + (n++) + '.json');
  fs.writeFileSync(f, raw);
  assert.throws(function () { main([write(base('2026-09-01')), '--ledger', f]); }, /Ledger at .* could not be read/,
    'wrong-shape ledger ' + raw + ' must stop the run');
  assert.strictEqual(fs.readFileSync(f, 'utf8'), raw, 'and the file is left exactly as it was: ' + raw);
});
var okLedger = path.join(dir, 'shape-ok.json');
main([write(base('2026-09-01')), '--ledger', okLedger]);
main([write(base('2026-09-02')), '--ledger', okLedger]);
fs.writeFileSync(path.join(dir, 'shape-old.json'), JSON.stringify({ rows: [] }));
main([write(base('2026-09-01')), '--ledger', path.join(dir, 'shape-old.json')]);

/* ---- 5. A same-day re-run that does not re-read the DM does not silently undo corrections ---- */
(function () {
  var NL = String.fromCharCode(10), fence = function (t) { return '```' + NL + t + NL + '```'; };
  var led = path.join(dir, 'rollback.json');
  var day1 = main([write(base('2026-09-01')), '--ledger', led]);
  var brief = day1.split('-- thread --')[0].trim(), details = day1.split('-- thread --')[1].trim();
  var ts = at(2026, 9, 1, 18);
  var d2 = function () {
    var i = base('2026-09-02');
    i.dm = { channel: 'D0', text: me(ts, fence(brief)) };
    i.dmThread = { root: ts, text: threadRead(ts, fence(brief), [
      [ts.replace(/[.]0+$/, '.000100'), fence(details)],
      [at(2026, 9, 1, 19).replace(/[.]0+$/, '.000200'), '1']]) };
    return i;
  };
  var run1 = main([write(d2()), '--ledger', led]);
  assert.ok(/marked not real/.test(run1) && /x/.test(verdicts(led)), 'precondition: the reply was applied on the first run today');
  var run2 = main([write(base('2026-09-02')), '--ledger', led]);      // the DM was not read this time
  assert.ok(!/x/.test(verdicts(led)), 'precondition: the re-run started from before the first, as designed');
  assert.ok(/NOT RE-APPLIED/.test(run2), 'and it says the earlier correction was not carried over: ' + run2.split(NL).slice(0, 12).join(' | '));
  var run3 = main([write(d2()), '--ledger', led]);      // read again: nothing was lost, nothing to warn about
  assert.ok(!/NOT RE-APPLIED/.test(run3), 'no warning when the reply was read again');
})();

/* ---- 6. The baseline is written only once the digest is posted and read back ---- */
(function () {
  var A = require('../src/alerts.js'), cli = require('../tools/alerts.js');
  var refusedText = function (c, args) { try { return c.main(args); } catch (e) { return e.stdout || String(e.message); } };
  var d = fs.mkdtempSync(path.join(os.tmpdir(), 'openloops-base-'));
  var cfg = path.join(d, 'openloops.config.json');
  fs.writeFileSync(cfg, JSON.stringify({ you: ME, ledger: path.join(d, 'ledger.json'), spotCheck: 0 }));
  var refOf = function (t) { return (t.split(String.fromCharCode(10))[0].match(/ref ([0-9a-f]{4})/) || [])[1]; };
  var baseFile = A.baselineFile(d);

  main([write(base('2026-09-30')), '--config', cfg, '--dry']);
  assert.ok(!fs.existsSync(baseFile), 'a dry run writes no baseline');
  var text = main([write(base('2026-09-30')), '--config', cfg]);
  assert.ok(!fs.existsSync(baseFile), 'a digest run only prints the digest: a post that never lands must not move the baseline');
  var ref = refOf(text);
  assert.ok(ref, 'precondition: the digest carries a ref');
  assert.ok(/Nothing staged/.test(refusedText(cli, ['--baseline', '--ref', 'ffff', '--config', cfg])), 'a ref that is not the staged digest promotes nothing');
  assert.ok(!fs.existsSync(baseFile));
  assert.ok(/Baseline recorded/.test(cli.main(['--baseline', '--ref', ref, '--config', cfg])), 'the read-back digest promotes its own baseline');
  var v1 = A.load(d).baseline;
  assert.strictEqual(v1.date, '2026-09-30');
  assert.ok(/Nothing staged/.test(refusedText(cli, ['--baseline', '--ref', ref, '--config', cfg])), 'and once: the staged copy is consumed');
  assert.deepStrictEqual(A.load(d).baseline, v1);

  // The next digest is drafted but never posted: the old baseline stands.
  var text2 = main([write(base('2026-10-01')), '--config', cfg]);
  assert.deepStrictEqual(A.load(d).baseline, v1, 'an unposted digest leaves the last posted baseline in place');
  // A stale staged copy cannot be promoted under the earlier digest's ref.
  assert.ok(/Nothing staged/.test(refusedText(cli, ['--baseline', '--ref', ref, '--config', cfg])));
  assert.ok(/Baseline recorded/.test(cli.main(['--baseline', '--ref', refOf(text2), '--config', cfg])));
  assert.strictEqual(A.load(d).baseline.date, '2026-10-01');
  assert.notStrictEqual(A.load(d).baseline.version, v1.version, 'every posted digest is a new version');
})();

/* ---- 7. --confirm names the alert by a unique id, so a rerun of the same slot cannot be confirmed by mistake ---- */
(function () {
  var A = require('../src/alerts.js'), cli = require('../tools/alerts.js');
  var d = fs.mkdtempSync(path.join(os.tmpdir(), 'openloops-confirm-'));
  var cfg = path.join(d, 'openloops.config.json');
  var ON = { delivery: 'dm', consentedAt: '2026-09-01T00:00:00.000Z', times: ['12:00', '15:00'] };
  fs.writeFileSync(cfg, JSON.stringify({ you: ME, alerts: ON }));
  A.writeBaseline(d, [], '2026-10-01');
  var overdue = { type: 'owed_by_us', what: 'x', due: '2026-09-30', workDue: '2026-09-30', status: 'overdue', overdueDays: 1, msgId: '1', subject: '#a' };
  var check = function (slot) {
    assert.ok(A.check(d, { alerts: ON }, { slot: slot, date: '2026-10-01', today: '2026-10-01', open: [overdue] }));
    return A.load(d).pending.id;
  };
  var confirm = function (id) { return cli.main(['--confirm'].concat(id ? ['--id', id] : [], ['--config', cfg])); };

  // The same slot is run twice before either is confirmed: the second replaces the first as pending.
  var first = check('12:00'), second = check('12:00');
  assert.ok(/^[0-9a-f]{16}$/.test(first) && /^[0-9a-f]{16}$/.test(second), 'each pending alert has an id');
  assert.notStrictEqual(first, second, 'a rerun of the same date and slot is a different alert');
  assert.throws(function () { confirm(first); }, /not the pending alert/i, 'confirming the first records nothing');
  assert.deepStrictEqual(A.load(d).alerted, {}, 'no item is recorded as alerted');
  assert.ok(!(A.load(d).slots['2026-10-01'] || {})['12:00'], 'and the slot is not done');
  assert.throws(function () { confirm(); }, /--id/, 'a confirm with no id is refused');
  assert.throws(function () { confirm('0000000000000000'); }, /not the pending alert/i, 'so is an id that was never issued');
  assert.ok(/Confirmed/.test(confirm(second)), 'the alert that is pending confirms');
  assert.ok((A.load(d).slots['2026-10-01'] || {})['12:00'], 'and completes its slot');
  assert.ok(/Nothing pending/.test(confirm(second)), 'and only once');

  // A later check that found nothing cleared pending; the earlier id has nothing to confirm.
  overdue = { type: 'owed_by_us', what: 'y', due: '2026-10-01', workDue: '2026-10-01', status: 'due_today', msgId: '2', subject: '#b' };
  var third = check('15:00');
  A.check(d, { alerts: ON }, { slot: '15:00', date: '2026-10-01', today: '2026-10-01', open: [] });
  assert.ok(/Nothing pending/.test(confirm(third)), 'an alert that a later check replaced with silence is not confirmed');
})();

/* ---- 8. The ledger's rename rides out a reader holding the file (Windows EPERM/EBUSY) ---- */
(function () {
  var { fileStore } = require('../src/store.js');
  var f = path.join(dir, 'busy-ledger.json');
  var store = fileStore(f);
  var real = fs.renameSync, left = 5;
  fs.renameSync = function (a, b) {
    if (left-- > 0) { var e = new Error('EPERM: operation not permitted, rename'); e.code = 'EPERM'; throw e; }
    return real.apply(fs, arguments);
  };
  try { store.writeLedger([]); } finally { fs.renameSync = real; }
  assert.ok(JSON.parse(fs.readFileSync(f, 'utf8')).rows, 'the ledger was written after the reader let go');
  // A different error is not retried: it is not the reader, and hiding it would hide a real fault.
  fs.renameSync = function () { var e = new Error('ENOSPC'); e.code = 'ENOSPC'; throw e; };
  try { assert.throws(function () { store.writeLedger([]); }, /ENOSPC/); } finally { fs.renameSync = real; }
})();

/* ---- 9. A mistyped --config stops the run; an absent default config is still fine ---- */
(function () {
  var withExclusion = cfgFile({ channels: { exclude: ['#halcyon'] } });
  var typo = path.join(dir, 'openloops.confg.json');
  var run = function (cfgPath) {
    var a = [write(base('2026-09-01')), '--ledger', path.join(dir, 'typo' + (n++) + '.json'), '--dry'];
    return main(cfgPath ? a.concat(['--config', cfgPath]) : a);
  };
  assert.throws(function () { run(typo); }, /--config .*does not exist/, 'a config path that is not there stops the run, it does not read everything');
  assert.throws(function () { main([write(base('2026-09-01')), '--dry', '--config']); }, /--config/, '--config with no path stops too');
  assert.throws(function () { main(['--report', '--config', typo]); }, /does not exist/, 'and so does --report');
  assert.ok(run(withExclusion).indexOf('scope doc') === -1, 'a real config still applies its exclusion');
  assert.ok(run(null).indexOf('scope doc') > -1, 'no --config at all is the documented default: nothing to load, nothing to stop');
})();

/* ---- 10. Slack timestamps are unique per channel, not per workspace: the same one in two channels is two messages ---- */
(function () {
  var T = at(2026, 8, 25, 11);
  var i = base('2026-09-01');
  i.conversations = [
    { channel: '#alpha', members: [], text: me(T, "I'll send the alpha proposal Wednesday.") },
    { channel: '#beta', members: [], text: me(T, "I'll send the beta contract Thursday.") }
  ];
  var out = main([write(i), '--ledger', path.join(dir, 'samets.json'), '--dry']);
  assert.ok(out.indexOf('alpha proposal') > -1 && out.indexOf('beta contract') > -1, 'both promises are listed, one per channel');
  assert.ok(out.indexOf('Read 2 messages across 2 conversations') > -1, 'and both count as read');

  // A thread read still replaces its own root, and only its own: channel #beta's message with the same ts stays.
  var ts = at(2026, 8, 26, 9);
  var j = base('2026-09-01');
  j.conversations = [
    { channel: '#alpha', members: [], text: me(ts, "I'll send the alpha plan Friday.") },
    { channel: '#beta', members: [], text: me(ts, "I'll send the beta plan Friday.") }
  ];
  j.threads = [{ channel: '#alpha', root: ts, text: threadRead(ts, me(ts, "I'll send the alpha plan Friday.").split(String.fromCharCode(10)).slice(2).join(String.fromCharCode(10)), []) }];
  var out2 = main([write(j), '--ledger', path.join(dir, 'samets2.json'), '--dry']);
  assert.ok(out2.indexOf('alpha plan') > -1 && out2.indexOf('beta plan') > -1, 'a thread read in one channel does not replace the other channel message');
})();

/* ---- 11. One odd message never aborts the whole run ---- */
(function () {
  var J = require('../src/slack-json.js');
  var NL = String.fromCharCode(10);
  var fine = { ts: '1788000400.000100', user: 'U0AAA', text: "I'll send the odd-channel deck Friday." };
  var withOdd = function (oddMsgs, led) {
    var i = base('2026-09-01');
    i.conversations.push({ channel: '#odd', members: [], messages: oddMsgs.concat([fine]) });
    return main([write(i), '--ledger', led || path.join(dir, 'odd' + (n++) + '.json'), '--dry']);
  };
  // Shapes Slack really sends, and that carry no promise: tolerated, and the rest of the channel is read.
  [['a bot message with bot_id and no user', { ts: '1788000100.000100', bot_id: 'B0BOT', text: 'Deploy finished' }],
   ['a bot message with no text at all', { ts: '1788000200.000100', user: 'U0BBB', bot_id: 'B0BOT', subtype: 'bot_message' }],
   ['a message whose only file was deleted', { ts: '1788000300.000100', user: 'U0CCC', text: '', files: [{ id: 'F0X', mode: 'tombstone' }] }]
  ].forEach(function (c) {
    var out = withOdd([c[1]]);
    assert.ok(out.indexOf('odd-channel deck') > -1 && out.indexOf('scope doc') > -1, c[0] + ': the run goes on and the channel is still read');
    assert.ok(out.indexOf('NOTHING READ IN #odd') === -1, c[0] + ': and nothing is reported broken');
  });
  // At the library, a user message with no text is still refused: that is a truncated read, not a bot.
  assert.throws(function () { J.parseMessages([{ ts: '1788000100.000100', user: 'U0AAA' }]); }, /Invalid Slack message/);
  assert.throws(function () { J.parseMessages([{ ts: '1788000100.000100', user: 'U0AAA', text: 'x', files: [{ id: 'F1' }] }]); }, /filenames/, 'and a nameless file that was not deleted');

  // A conversation that really is malformed fails alone: named, with the reason, and the others are read.
  var led = path.join(dir, 'oddled.json');
  var i1 = base('2026-09-01');
  i1.conversations.push({ channel: '#odd', members: [], messages: [fine] });
  main([write(i1), '--ledger', led]);
  assert.ok(rowsOf(led).length >= 3, 'precondition: the odd channel contributed a tracked item');
  var stderrOf = [], realErr = process.stderr.write;
  process.stderr.write = function (t) { stderrOf.push(String(t)); return true; };
  var broken;
  try { broken = withOdd([{ ts: 'broken', user: 'U0AAA', text: 'x' }], led); } finally { process.stderr.write = realErr; }
  assert.ok(broken.indexOf('scope doc') > -1, 'the other conversations are still in the digest');
  assert.ok(broken.indexOf(NOT_READ('#odd')) > -1, 'the failed one is named, in the agreed words');
  assert.ok(broken.indexOf('NOTHING READ IN #odd') === -1, 'and not also reported as an empty read');
  assert.ok(/#odd was not read: Invalid Slack message/.test(stderrOf.join('')), 'and its reason goes to stderr: ' + stderrOf.join(''));
  assert.ok(broken.indexOf('CLEARED SINCE THE LAST RUN') === -1 || broken.split('CLEARED SINCE THE LAST RUN')[1].indexOf('odd-channel deck') === -1,
    'and what it held is not reported cleared just because it could not be read');
  assert.ok(rowsOf(led).length >= 3, 'nor dropped from the ledger');

  // A thread read that cannot be parsed is the same: it does not take the run down.
  var t = base('2026-09-01');
  t.threads = [{ channel: '#halcyon', root: '1788000500.000100', messages: [{ ts: 'nope', user: 'U0AAA', text: 'x' }] }];
  var tout = main([write(t), '--ledger', path.join(dir, 'oddthread.json'), '--dry']);
  assert.ok(tout.indexOf('scope doc') > -1 && tout.indexOf(NOT_READ('#halcyon thread 1788000500.000100')) > -1, 'a bad thread read is named and skipped');
})();

/* ---- 12. Spot-check sampling tells two channels' messages apart: one flagged, one silent, same ts ---- */
(function () {
  var T = at(2026, 8, 25, 11);
  var i = base('2026-09-01');
  i.spotCheck = 5;
  i.conversations = [
    { channel: '#alpha', members: [], text: me(T, "I'll send the alpha proposal Wednesday.") },
    { channel: '#beta', members: [], text: me(T, 'Lunch at the usual place, see everyone at noon') }
  ];
  var out = main([write(i), '--ledger', path.join(dir, 'samets3.json'), '--dry']);
  assert.ok(out.indexOf('alpha proposal') > -1, 'precondition: the alpha promise is flagged');
  var spot = out.split('SPOT CHECK')[1] || '';
  assert.ok(spot.indexOf('Lunch at the usual place') > -1, 'the silent message in #beta is still sampled, though #alpha flagged one with its timestamp');
  assert.ok(spot.indexOf('alpha proposal') === -1, 'and the flagged one is not');
  // Nothing colliding: the id is still the plain timestamp, so ordinary runs are unchanged.
  var j = base('2026-09-01'); j.spotCheck = 5;
  var plain = main([write(j), '--ledger', path.join(dir, 'samets4.json'), '--dry']);
  var again = main([write(j), '--ledger', path.join(dir, 'samets5.json'), '--dry']);
  assert.strictEqual(plain, again, 'a run with no collisions is deterministic');
})();

/* ---- 13. Message and thread identities are channel-aware and stable ---- */
(function () {
  var loops = require('../src/loops.js');
  var NL = String.fromCharCode(10);
  var asked = function (f) { var a = JSON.parse(fs.readFileSync(f, 'utf8')).audit.asked; return [].concat.apply([], Object.keys(a).map(function (d) { return a[d]; })); };
  var T = at(2026, 8, 25, 11);
  var chat = function (channel, body) { return { channel: channel, members: [], text: me(T, body) }; };
  var QUIET_A = 'Notes from the planning sync, nothing to do here today';
  var QUIET_B = 'Lunch at the usual place, see everyone at noon';

  // The same message keeps its identity whether or not another channel with the same timestamp was fetched.
  var both = base('2026-09-01'); both.spotCheck = 5;
  both.conversations = [chat('#alpha', QUIET_A), chat('#beta', QUIET_B)];
  var ledBoth = path.join(dir, 'id-both.json');
  main([write(both), '--ledger', ledBoth]);
  var alone = base('2026-09-01'); alone.spotCheck = 5;
  alone.conversations = [chat('#beta', QUIET_B)];
  var ledAlone = path.join(dir, 'id-alone.json');
  main([write(alone), '--ledger', ledAlone]);
  var idsBoth = asked(ledBoth), idsAlone = asked(ledAlone);
  assert.strictEqual(idsBoth.length, 2);
  assert.strictEqual(idsAlone.length, 1);
  assert.ok(idsBoth.some(function (x) { return x.indexOf('#alpha') > -1; }) && idsBoth.some(function (x) { return x.indexOf('#beta') > -1; }), 'each id names its own channel: ' + idsBoth);
  assert.ok(idsBoth.indexOf(idsAlone[0]) > -1, "#beta's message has the same id with and without #alpha: " + idsBoth + ' vs ' + idsAlone);
  assert.ok(idsAlone[0].indexOf(T) === 0 && idsAlone[0].indexOf('#beta') > -1, 'and the id carries the original timestamp and the channel: ' + idsAlone[0]);

  // A thread identity carries its channel to the detector and into the ledger key.
  var legacy = loops.loopKey({ type: 'owed_to_us', threadId: T, said: '2026-08-25', what: 'x' });
  var qualified = loops.loopKey({ type: 'owed_to_us', threadId: T + '@#alpha', said: '2026-08-25', what: 'x' });
  assert.notStrictEqual(qualified, legacy, 'a new commitment in a thread is keyed by its channel as well');
  assert.strictEqual(loops.legacyKey(qualified), legacy, 'and legacyKey gives back exactly the key every existing ledger row has');
  assert.strictEqual(loops.legacyKey(legacy), legacy, 'a key with no channel part is returned as it is');
  assert.notStrictEqual(loops.loopKey({ type: 'owed_to_us', threadId: '#alpha', said: '2026-08-25', what: 'x' }), legacy);

  // Equal thread-root timestamps in two channels are two threads: one cannot close the other's commitment.
  var users = { U0LENA: { email: 'lena@vectorfreight.com', name: 'Lena Borg' } };
  var root = '1788000000.000100', promiseTs = '1788000100.000100', laterTs = '1788000200.000100';
  var mk = function (alphaThread, betaThread) {
    var i = base('2026-09-01'); i.conversations = []; i.users = users;
    i.threads = [
      { channel: '#alpha', root: root, messages: alphaThread },
      { channel: '#beta', root: root, messages: betaThread }
    ];
    return i;
  };
  var promise = { ts: promiseTs, thread_ts: root, user: 'U0LENA', text: "We'll send the revised contract Friday." };
  var head = { ts: root, thread_ts: root, user: 'U0LENA', text: 'Thread about the contract' };
  var delivery = { ts: laterTs, thread_ts: root, user: 'U0LENA', text: 'Attached the revised contract.' };
  var led13 = path.join(dir, 'id-threads.json');
  var out13 = main([write(mk([head, promise], [head, delivery])), '--ledger', led13]);
  assert.ok(out13.indexOf('revised contract Friday') > -1, "#beta's delivery does not close #alpha's promise");
  assert.ok((out13.split('CLOSED ITSELF')[1] || '').indexOf('revised contract Friday') === -1, 'and it is not listed as closed');
  // Control: the delivery in the SAME thread does close it, so the test is able to see a close.
  var out13b = main([write(mk([head, promise, delivery], [head])), '--ledger', path.join(dir, 'id-threads2.json'), '--dry']);
  assert.ok(out13b.indexOf('CLOSED ITSELF') > -1 || out13b.indexOf('revised contract Friday') === -1, 'control: a delivery in its own thread closes it');

  // A verdict recorded under the new key holds.
  var rows13 = JSON.parse(fs.readFileSync(led13, 'utf8')).rows;
  var row = rows13.filter(function (r) { return /revised contract/.test(r[6] || ''); })[0];
  assert.ok(row, 'precondition: the thread item is tracked');
  assert.strictEqual(row[0].split('|')[1], root + '@#alpha', 'a new commitment is keyed by thread root and channel: ' + row[0]);
  var led = JSON.parse(fs.readFileSync(led13, 'utf8'));
  led.rows.forEach(function (r) { if (r[0] === row[0]) r[7] = 'x'; });
  fs.writeFileSync(led13, JSON.stringify(led));
  var nextDay = mk([head, promise], [head, delivery]); nextDay.today = '2026-09-02';
  var after = main([write(nextDay), '--ledger', led13, '--dry']);
  assert.ok(after.indexOf('revised contract Friday') === -1, 'a verdict on the channel-qualified key hides the item');
})();

/* ---- 14. Channel-qualified keys for new commitments; legacy bare-root records matched only when unambiguous ---- */
(function () {
  var loops = require('../src/loops.js'), A = require('../src/alerts.js');
  var NL = String.fromCharCode(10), fence = function (t) { return '```' + NL + t + NL + '```'; };
  var users = { U0LENA: { email: 'lena@vectorfreight.com', name: 'Lena Borg' } };
  var root = '1788000000.000100';
  var head = { ts: root, thread_ts: root, user: 'U0LENA', text: 'Thread about the contract' };
  var promise = { ts: '1788000100.000100', thread_ts: root, user: 'U0LENA', text: "We'll send the revised contract Friday." };
  // complete: true is the connector's own evidence that nothing was cut off; without it a read is 'unknown' and legacy records wait.
  var thread = function (channel) { return { channel: channel, root: root, messages: [head, promise], complete: true }; };
  var input = function (today, channels, extraConv) {
    var i = base(today); i.conversations = extraConv || []; i.users = users;
    i.threads = channels.map(thread);
    return i;
  };
  var openCount = function (out) { return Number((out.match(/(\d+) open/) || [])[1]); };
  var load = function (f) { return JSON.parse(fs.readFileSync(f, 'utf8')); };
  var save = function (f, o) { fs.writeFileSync(f, JSON.stringify(o)); };
  var LEGACY = loops.legacyKey;
  var rowsWith = function (f, frag) { return load(f).rows.filter(function (r) { return r[0].indexOf(frag) > -1; }); };
  var NOT_MATCHED = function (n, channels) {
    return 'NOT MATCHED — an older tracking record matches ' + n + ' commitments (' + channels + '). They are tracked separately. ' +
      'Any earlier correction was applied to neither; reply to the current digest to correct the one you meant.';
  };
  var NOT_APPLIED = 'NOT APPLIED — your correction refers to an older item that now matches multiple commitments. Reply to the current digest to identify the one you meant.';
  var warnings = function (out, re) { return out.split(NL).filter(function (l) { return re.test(l); }).join(' | '); };
  // A ledger as the previous code would have left it: the commitment held in both threads was ONE row under the bare-root key.
  var legacyLedger = function (name, verdict, keepQ) {
    var f = path.join(dir, name);
    main([write(input('2026-09-01', ['#alpha', '#beta'])), '--ledger', f]);
    var led = load(f), q = led.rows.map(function (r) { return r[0]; }), lk = LEGACY(q[0]);
    assert.strictEqual(q.length, 2, 'precondition: two channels, two keys, two rows: ' + q);
    assert.strictEqual(LEGACY(q[1]), lk, 'precondition: both share one legacy key');
    var legacyRow = led.rows[0].slice(); legacyRow[0] = lk; legacyRow[7] = verdict;
    led.rows = keepQ ? led.rows.concat([legacyRow]) : [legacyRow];
    save(f, led);
    return { file: f, legacy: lk, qs: q };
  };

  // Identical commitments on the same day in two channels sharing a root: rejecting one leaves the other open.
  var led1 = path.join(dir, 'kq1.json');
  var day1 = main([write(input('2026-09-01', ['#alpha', '#beta'])), '--ledger', led1]);
  assert.strictEqual(openCount(day1), 2, 'two channels, two commitments, even with the same sentence and root');
  var ts = at(2026, 9, 1, 18), brief = day1.split('-- thread --')[0].trim(), details = day1.split('-- thread --')[1].trim();
  var d2 = input('2026-09-02', ['#alpha', '#beta']);
  d2.dm = { channel: 'D0', text: me(ts, fence(brief)) };
  d2.dmThread = { root: ts, text: threadRead(ts, fence(brief), [
    [ts.replace(/[.]0+$/, '.000100'), fence(details)], [at(2026, 9, 1, 19).replace(/[.]0+$/, '.000200'), '1']]) };
  var day2 = main([write(d2), '--ledger', led1]);
  assert.strictEqual(load(led1).rows.filter(function (r) { return r[7] === 'x'; }).length, 1, 'exactly one of the two was rejected');
  assert.strictEqual(openCount(day2), 1, 'and the other is still open: ' + day2.split(NL).slice(0, 3).join(' | '));

  // Legacy, unambiguous, every read complete: the verdict carries over, the row is re-keyed, and old digests still resolve.
  var c = legacyLedger('kq2.json', 'x', false);
  var led2 = load(c.file);
  var toLegacy = function (k) { return k === c.qs[0] || k === c.qs[1] ? c.legacy : k; };
  Object.keys(led2.digests).forEach(function (k) { led2.digests[k] = led2.digests[k].map(toLegacy); });
  Object.keys(led2.refs).forEach(function (r) { led2.refs[r].keys = led2.refs[r].keys.map(toLegacy); });
  save(c.file, led2);
  var one = main([write(input('2026-09-02', ['#alpha'])), '--ledger', c.file]);
  assert.strictEqual(openCount(one), 0, 'a verdict recorded under the bare-root key still hides its one match');
  var after2 = load(c.file);
  assert.deepStrictEqual(rowsWith(c.file, '|' + root + '@#alpha|').map(function (r) { return r[7]; }), ['x'], 'the row moved to the channel-qualified key and kept its verdict');
  assert.strictEqual(after2.rows.filter(function (r) { return r[0] === c.legacy || r[0] === c.legacy + '|ambiguous'; }).length, 0, 'no legacy copy is left behind');
  assert.ok(JSON.stringify(after2.digests).indexOf(root + '@#alpha') > -1 && JSON.stringify(after2.digests).indexOf(c.legacy) === -1, 'older digest memos now name the new key');
  assert.ok(JSON.stringify(after2.refs).indexOf(c.legacy) === -1, 'and so do reply references');

  // Legacy, but a conversation could not be read: the record is preserved and the current item left uncorrected, until a complete run.
  var d = legacyLedger('kq3.json', 'x', false);
  var partial = input('2026-09-02', ['#alpha'], [{ channel: '#odd', members: [], messages: [{ ts: 'broken', user: 'U0AAA', text: 'x' }] }]);
  var realErr = process.stderr.write; process.stderr.write = function () { return true; };
  var out3; try { out3 = main([write(partial), '--ledger', d.file]); } finally { process.stderr.write = realErr; }
  assert.strictEqual(openCount(out3), 1, 'with an incomplete read the old verdict is not applied to the current item');
  assert.ok(load(d.file).rows.some(function (r) { return r[0] === d.legacy && r[7] === 'x'; }), 'the legacy record is preserved under its own key');
  assert.ok(out3.indexOf('CLEARED SINCE THE LAST RUN') === -1 || out3.split('CLEARED SINCE THE LAST RUN')[1].indexOf('revised contract') === -1, 'and is not reported cleared');
  var out3b = main([write(input('2026-09-03', ['#alpha'])), '--ledger', d.file]);
  assert.strictEqual(openCount(out3b), 0, 'the next complete run applies it');
  assert.ok(load(d.file).rows.every(function (r) { return r[0] !== d.legacy; }), 'and retires the legacy row');

  // Legacy record matching two channels: applied to neither, preserved, and flagged, with or without a verdict.
  [['x', 'with a verdict'], ['', 'with no verdict']].forEach(function (v) {
    var a = legacyLedger('kq4' + (v[0] || 'none') + '.json', v[0], false);
    var out4 = main([write(input('2026-09-02', ['#alpha', '#beta'])), '--ledger', a.file]);
    assert.strictEqual(openCount(out4), 2, v[1] + ': both commitments are open');
    assert.ok(out4.indexOf(NOT_MATCHED(2, '#alpha, #beta')) > -1, v[1] + ': the ambiguity is flagged, exactly: ' + warnings(out4, /NOT MATCHED/));
    assert.strictEqual(rowsWith(a.file, a.legacy + '|ambiguous').length, 1, v[1] + ': the record is preserved, inert');
    assert.ok(load(a.file).rows.filter(function (r) { return r[0].indexOf('@#') > -1; }).every(function (r) { return !r[7]; }), v[1] + ': neither new row inherited it');
    assert.ok(out4.indexOf('CLEARED SINCE THE LAST RUN') === -1, v[1] + ': and it is not reported as cleared');
    var again = main([write(input('2026-09-03', ['#alpha', '#beta'])), '--ledger', a.file]);
    assert.ok(again.indexOf('NOT MATCHED') === -1, v[1] + ': flagged once, not every day');
  });

  // Existing channel-qualified rows do not make a collision look unique.
  var e = legacyLedger('kq5.json', 'x', true);
  var out5 = main([write(input('2026-09-02', ['#alpha', '#beta'])), '--ledger', e.file]);
  assert.ok(out5.indexOf(NOT_MATCHED(2, '#alpha, #beta')) > -1, 'both channels already have their own rows, and the legacy record still matches two');
  assert.strictEqual(openCount(out5), 2);

  // A reply to an older digest whose item now matches two commitments is reported, not silently dropped.
  var f6 = path.join(dir, 'kq6.json');
  var old = main([write(input('2026-09-01', ['#alpha'])), '--ledger', f6]);
  var led6 = load(f6), q6 = led6.rows[0][0], l6 = LEGACY(q6);
  var to6 = function (x) { return x === q6 ? l6 : x; };
  led6.rows[0][0] = l6;
  Object.keys(led6.digests).forEach(function (k) { led6.digests[k] = led6.digests[k].map(to6); });
  Object.keys(led6.refs).forEach(function (r) { led6.refs[r].keys = led6.refs[r].keys.map(to6); });
  save(f6, led6);
  var b6 = old.split('-- thread --')[0].trim(), det6 = old.split('-- thread --')[1].trim();
  var d6 = input('2026-09-02', ['#alpha', '#beta']);
  d6.dm = { channel: 'D0', text: me(ts, fence(b6)) };
  d6.dmThread = { root: ts, text: threadRead(ts, fence(b6), [
    [ts.replace(/[.]0+$/, '.000100'), fence(det6)], [at(2026, 9, 1, 19).replace(/[.]0+$/, '.000200'), '1']]) };
  var out6 = main([write(d6), '--ledger', f6]);
  assert.ok(out6.indexOf(NOT_APPLIED) > -1, 'the reply is reported: ' + warnings(out6, /NOT APPLIED|NOT MATCHED/));
  assert.strictEqual(openCount(out6), 2, 'and neither commitment was rejected by it');

  // Alert baseline: an old entry counts for the one commitment it maps to, and never suppresses two.
  var mkItem = function (channel) {
    return { type: 'owed_to_us', threadId: root + '@' + channel, said: '2026-08-25', what: 'We will send the contract', due: '2026-08-28', workDue: '2026-08-28', status: 'overdue', overdueDays: 4, who: 'lena@x.io', subject: channel };
  };
  var legacyKey = LEGACY(loops.loopKey(mkItem('#alpha')));
  var st = function (items) { return { baseline: { items: items }, alerted: {} }; };
  var baselineOld = {}; baselineOld[legacyKey] = 3;
  assert.strictEqual(A.evaluate([mkItem('#alpha')], st(baselineOld), '2026-09-01').length, 0, 'a legacy baseline entry that maps to one commitment suppresses it, as before');
  assert.strictEqual(A.evaluate([mkItem('#alpha'), mkItem('#beta')], st(baselineOld), '2026-09-01').length, 2, 'one that maps to two suppresses neither');
})();

console.log('hardening: OK');
