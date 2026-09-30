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
assert.ok(/READ NOTHING/.test(none) && !/Genuinely/.test(none), 'no conversations handed over: ' + none.split(String.fromCharCode(10)).slice(0, 4).join(' | '));
var noneKey = quiet(function (i) { delete i.conversations; });
assert.ok(/READ NOTHING/.test(noneKey) && !/Genuinely/.test(noneKey), 'no conversations key at all');
var scoped = quiet(function () {}, { channels: { include: ['#does-not-exist'] } });
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

console.log('hardening: OK');
