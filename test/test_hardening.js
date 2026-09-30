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
  assert.ok(/Nothing staged/.test(cli.main(['--baseline', '--ref', 'ffff', '--config', cfg])), 'a ref that is not the staged digest promotes nothing');
  assert.ok(!fs.existsSync(baseFile));
  assert.ok(/Baseline recorded/.test(cli.main(['--baseline', '--ref', ref, '--config', cfg])), 'the read-back digest promotes its own baseline');
  var v1 = A.load(d).baseline;
  assert.strictEqual(v1.date, '2026-09-30');
  assert.ok(/Nothing staged/.test(cli.main(['--baseline', '--ref', ref, '--config', cfg])), 'and once: the staged copy is consumed');
  assert.deepStrictEqual(A.load(d).baseline, v1);

  // The next digest is drafted but never posted: the old baseline stands.
  var text2 = main([write(base('2026-10-01')), '--config', cfg]);
  assert.deepStrictEqual(A.load(d).baseline, v1, 'an unposted digest leaves the last posted baseline in place');
  // A stale staged copy cannot be promoted under the earlier digest's ref.
  assert.ok(/Nothing staged/.test(cli.main(['--baseline', '--ref', ref, '--config', cfg])));
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

console.log('hardening: OK');
