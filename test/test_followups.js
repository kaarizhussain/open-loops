/* Follow-ups from the adversarial test run.
 *
 *  1. A restores.json the digest cannot read is said so in the digest, not silently ignored.
 *  2. A configuration that --check-config passes can no longer crash the run: one validator, exit 3.
 *  3. A second --begin keeps the unfinished attempt, and its --end still reports.
 *  4. The mass-reply guard also covers "k" lines and rejections split across several replies; numbers joined by odd separators are reported.
 *  5. Capped lines say how many were held back, and a held-back restore note is not counted as carried.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');
var { main, marksFromDm } = require('../slack-run.js');
var { settings } = require('../src/config.js');
var cli = require('../tools/status.js');
var S = require('../src/status.js');
var L = require('../src/ledger.js');
var R = require('../src/restore.js');

var ROOT = path.join(__dirname, '..'), NL = String.fromCharCode(10), ME = 'alex@example.com';
var tmp = function () { return fs.mkdtempSync(path.join(os.tmpdir(), 'ol-follow-')); };
var run = function (args) { return cp.spawnSync(process.execPath, [path.join(ROOT, 'slack-run.js')].concat(args), { encoding: 'utf8', cwd: ROOT }); };
var ts = function (mo, d, h, mi) { return (Date.UTC(2026, mo - 1, d, h, mi || 0) / 1000).toFixed(6); };
var banner = function (t, body) { return '=== Message from Lena Borg <lena@vf.example> (U0EXAMPLE002) at ' + t + ' UTC ===' + NL + 'Message TS: ' + t + NL + body; };
var fenced = function (t, d) { return banner(t, '```' + NL + d + NL + '```'); };

var world = function (words) {
  var dir = tmp(), cfg = path.join(dir, 'openloops.config.json'), ledger = path.join(dir, 'ledger.json'), n = 0;
  fs.writeFileSync(cfg, JSON.stringify({ you: ME, selfDm: 'U0EXAMPLE001', tzOffset: 0, spotCheck: 0, ledger: ledger, channels: { include: ['#ops'] } }));
  var chat = (words || ['alpha', 'bravo', 'charlie']).map(function (w, i) { return banner(ts(9, 28, 1 + i), 'Please send the ' + w + ' report Thursday Oct 1.'); }).join(NL);
  return {
    dir: dir, cfg: cfg, ledger: ledger,
    run: function (today, extra) {
      var p = path.join(dir, 'in' + (n++) + '.json');
      fs.writeFileSync(p, JSON.stringify(Object.assign({ today: today, conversations: [{ channel: '#ops', members: [], text: chat, complete: true }], dm: { channel: 'D0', text: '' } }, extra || {})));
      return main([p, '--config', cfg]);
    },
    data: function () { return JSON.parse(fs.readFileSync(ledger, 'utf8')); }
  };
};

/* ============================== 1. a restores.json that cannot be read ============================== */
var DAMAGED_LINE = 'RESTORE REQUESTS NOT PROCESSED — restores.json could not be read, so no queued restore was applied. The file was preserved. Ask your assistant to inspect it.';
['{"requests":[{"id":"aaaa', '[]', '{"requests":{}}', 'not json at all'].forEach(function (bytes) {
  var w = world();
  w.run('2026-09-30');
  fs.writeFileSync(path.join(w.dir, 'restores.json'), bytes);
  var out = w.run('2026-10-01');
  assert.ok(out.split(NL).indexOf(DAMAGED_LINE) > -1, JSON.stringify(bytes) + ': the digest says so: ' + out.split(NL).slice(0, 6).join(' / '));
  assert.strictEqual(fs.readFileSync(path.join(w.dir, 'restores.json'), 'utf8'), bytes, 'and the file is left exactly as it is');
});
var okW = world();
okW.run('2026-09-30');
fs.writeFileSync(path.join(okW.dir, 'restores.json'), JSON.stringify({ requests: [] }));
assert.ok(okW.run('2026-10-01').indexOf('RESTORE REQUESTS NOT PROCESSED') === -1, 'a readable file, even an empty one, says nothing');
assert.ok(world().run('2026-10-01').indexOf('RESTORE REQUESTS NOT PROCESSED') === -1, 'and neither does no file');

/* ============================== 2. one validator: what the check passes cannot crash the run ============================== */
var INPUT = JSON.stringify({ today: '2026-10-01', conversations: [{ channel: '#ops', members: [], text: '', complete: true }], dm: { channel: 'D0', text: '' } });
var configCase = function (text) {
  var d = tmp(), c = path.join(d, 'c.json'), i = path.join(d, 'in.json');
  fs.writeFileSync(c, text); fs.writeFileSync(i, INPUT);
  return { check: run(['--check-config', '--config', c]), run: run([i, '--config', c, '--dry']), dir: d };
};
var GOOD = { you: 'you@example.com', selfDm: 'U0EXAMPLE001' };
var FIX = ' Fix the configuration before fetching or running a digest.';
var BAD = [
  ['null', 'the config file must hold a JSON object, got null'],
  ['"text"', 'the config file must hold a JSON object, got "text"'],
  ['5', 'the config file must hold a JSON object, got 5'],
  ['[]', 'the config file must hold a JSON object, got []'],
  [JSON.stringify(Object.assign({ mute: 'x' }, GOOD)), '"mute" must be a list of phrases, got "x"'],
  [JSON.stringify(Object.assign({ mute: [1] }, GOOD)), '"mute" must be a list of phrases, got [1]'],
  [JSON.stringify(Object.assign({ unmute: 5 }, GOOD)), '"unmute" must be a list of phrases, got 5'],
  [JSON.stringify(Object.assign({ lookbackDays: 'x' }, GOOD)), '"lookbackDays" must be a number of days from 0 to 3650 (0 reads without a window), got "x"'],
  [JSON.stringify(Object.assign({ lookbackDays: -1 }, GOOD)), '"lookbackDays" must be a number of days from 0 to 3650 (0 reads without a window), got -1'],
  [JSON.stringify(Object.assign({ ledger: 5 }, GOOD)), '"ledger" must be a file path, got 5'],
  [JSON.stringify(Object.assign({ ledger: '' }, GOOD)), '"ledger" must be a file path, got ""'],
  [JSON.stringify(Object.assign({ ledger: ['a'] }, GOOD)), '"ledger" must be a file path, got ["a"]']
];
BAD.forEach(function (c) {
  var r = configCase(c[0]);
  assert.strictEqual(r.check.status, 3, c[0] + ': the check refuses it: ' + r.check.stderr);
  assert.strictEqual(r.check.stderr.trim(), 'open-loops: Config is unusable: ' + c[1] + '.' + FIX);
  assert.strictEqual(r.run.status, 3, c[0] + ': and so does the run, as a configuration problem (not the ledger, not a crash): ' + r.run.stderr);
});
// What is fine stays fine: 0 means no window, and a number written as a string was always accepted.
[{ lookbackDays: 0 }, { lookbackDays: '21' }, { lookbackDays: 7.5 }, { mute: ['standup'] }, { unmute: [] }, { ledger: 'led.json' }].forEach(function (extra) {
  var r = configCase(JSON.stringify(Object.assign({}, GOOD, extra)));
  assert.strictEqual(r.check.status, 0, JSON.stringify(extra) + ': ' + r.check.stderr);
  assert.strictEqual(r.run.status, 0, JSON.stringify(extra) + ' runs: ' + r.run.stderr);
});
assert.throws(function () { settings(fs, path.join(tmp(), 'nope.json'), {}); }, /"you"/, 'a missing file is still only missing its address');

/* ============================== 3. a second --begin keeps the unfinished attempt ============================== */
var sd = tmp(), cfgS = path.join(sd, 'c.json');
var begin = function (hhmm) { return cli.main(['--begin', '--today', '2026-10-01', '--now', '2026-10-01T' + hhmm, '--config', cfgS]).match(/ATTEMPT ([0-9a-f]+)/)[1]; };
var endFlags = function (id, flags) { var errs = []; var out = cli.main(['--end', '--attempt', id, '--config', cfgS].concat(flags), function (m) { errs.push(m); }); return { out: out, err: errs.join(NL) }; };
var FAIL_BUILD = ['--brief', 'not_attempted', '--details', 'not_attempted', '--verified', 'no', '--failed', 'build'];
var first = begin('18:00'), second = begin('18:30');
assert.strictEqual(S.load(sd).attempt.id, second, 'the later attempt is the last attempt');
assert.deepStrictEqual(S.load(sd).superseded.map(function (x) { return x.id; }), [first], 'and the first is kept');
var view1 = S.view(sd, {}, null, S.parseNow('2026-10-01T19:00'), {});
assert.ok(/An earlier attempt \(Thu 18:00\) started and was replaced by a later one before reporting an outcome\./.test(view1), view1);
var ended = endFlags(first, FAIL_BUILD);
assert.ok(/^OPEN LOOPS NOT RUN — for 2026-10-01/.test(ended.out), 'its --end still prints its notice: ' + ended.out);
assert.ok(ended.err.indexOf('attempt ' + first + ' was replaced by a later attempt before it ended; its notice is printed, but it is not the last attempt, so its notice result is not recorded.') > -1, ended.err);
assert.ok(ended.err.indexOf('--notice-result') === -1, 'and it does not send the assistant to record a notice result that cannot be recorded');
assert.strictEqual(S.load(sd).attempt.id, second, 'the last attempt is unchanged');
assert.strictEqual(S.load(sd).attempt.outcome, 'started');
assert.deepStrictEqual(S.load(sd).superseded, [], 'and the replaced attempt is no longer listed');
assert.ok(!/earlier attempt/.test(S.view(sd, {}, null, S.parseNow('2026-10-01T19:00'), {})));
assert.throws(function () { endFlags(first, FAIL_BUILD); }, /no attempt .* is open/, 'a second --end for it is not a second notice');
assert.throws(function () { endFlags('0000abcd', FAIL_BUILD); }, /no attempt 0000abcd is open/, 'an id that never began is still an error');
// A replaced attempt that was in fact delivered still records the delivery, and leaves the last attempt alone.
var sd2 = tmp(); cfgS = path.join(sd2, 'c.json'); sd = sd2;
var d1 = begin('18:00'), d2 = begin('18:30');
var delivered = endFlags(d1, ['--brief', 'posted', '--details', 'posted', '--verified', 'yes', '--ref', 'abcd']);
assert.ok(/^DELIVERED — recorded\. \(Attempt .* had been replaced by a later one; the last attempt is unchanged\.\)$/.test(delivered.out), delivered.out);
assert.strictEqual(S.load(sd).delivered.ref, 'abcd', 'the delivery is recorded');
assert.strictEqual(S.load(sd).attempt.id, d2, 'the last attempt is not');
// Only the last three are kept.
var sd3 = tmp(); cfgS = path.join(sd3, 'c.json'); sd = sd3;
var ids = [begin('10:00'), begin('11:00'), begin('12:00'), begin('13:00'), begin('14:00')];
assert.deepStrictEqual(S.load(sd).superseded.map(function (x) { return x.id; }), ids.slice(1, 4), 'the three most recent unfinished attempts');
// A finished attempt is not "unfinished": a new --begin keeps nothing.
var sd4 = tmp(); cfgS = path.join(sd4, 'c.json'); sd = sd4;
var f1 = begin('10:00'); endFlags(f1, ['--brief', 'posted', '--details', 'posted', '--verified', 'yes', '--ref', 'abcd']);
begin('11:00');
assert.deepStrictEqual(S.load(sd4).superseded, []);

/* ============================== 4. the mass-reply guard, and odd separators ============================== */
var keys8 = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8'];
var store = {
  seenReplies: function () { return []; }, refsSince: function () { return '2026-09-22'; },
  recallRef: function (r) { return r === 'cccc' ? { date: '2026-09-23', keys: keys8, asked: [] } : null; }
};
var rows8 = function (xs) { return keys8.map(function (k) { var v = xs && xs.indexOf(k) > -1 ? 'x' : ''; return [k, '2026-09-01', '2026-09-23', '', 'owed_by_us', '', '', v]; }); };
var head = { id: '100.1', threadId: '100.1', body: 'OPEN LOOPS — for 2026-09-23 · ref cccc' + NL + 'x' };
var replies = function (bodies, already) {
  var rows = rows8(already), msgs = [head].concat(bodies.map(function (b, i) { return { id: (200 + i) + '.1', threadId: '100.1', body: b }; }));
  var r = marksFromDm(msgs, store, rows);
  return { r: r, x: rows.filter(function (x) { return x[7] === 'x'; }).length, k: rows.filter(function (x) { return x[7] === 'k'; }).length };
};
var pasteK = replies(['k 1-8']);
assert.strictEqual(pasteK.k, 0, 'a k-range over the whole list is not applied');
assert.strictEqual(pasteK.r.mass.length, 1);
assert.strictEqual(pasteK.r.mass[0].kind, 'known');
assert.strictEqual(replies(['k 1 2 3 4 5 6']).k, 0, 'in any spelling');
assert.strictEqual(replies(['k 1 2 3']).k, 3, 'a few k marks are a correction, as ever');
assert.strictEqual(replies(['k 1 2 3 4']).k, 4, 'four of eight is not more than half');
// Rejections split across messages are counted together, per digest.
var split = replies(['1-3', '4-6']);
assert.strictEqual(split.x, 3, 'the first reply stands; the one that takes the digest past the line is held');
assert.strictEqual(split.r.mass.length, 1);
assert.strictEqual(split.r.mass[0].kind, 'together');
assert.strictEqual(split.r.mass[0].count, 6);
assert.strictEqual(split.r.mass[0].text, '4-6');
assert.ok(split.r.seen.indexOf('201.1') > -1, 'and it is read once: it is not re-read tomorrow');
assert.strictEqual(replies(['1-2', '3-4']).x, 4, 'four of eight across two messages is not more than half');
assert.strictEqual(replies(['1', '2', '3', '4', '5']).x, 4, 'five single replies: the fifth takes it past the line');
assert.strictEqual(replies(['4 5'], ['k1', 'k2', 'k3']).x, 3, 'rejections the ledger already holds for this digest count too (3 held + 2 new = 5 of 8)');
assert.strictEqual(replies(['4'], ['k1', 'k2', 'k3']).x, 4, 'but 3 held + 1 new is 4 of 8: a correction');
var restated = replies(['1 2 3'], ['k1', 'k2', 'k3']);
assert.strictEqual(restated.r.mass.length, 0, 'naming items that are already rejected adds nothing: 3 held + 0 new is not a paste');
assert.strictEqual(restated.x, 3);
var again = replies(['1 2', '1 2']);
assert.strictEqual(again.x, 2, 'the same items named twice are counted once');
assert.strictEqual(again.r.mass.length, 0);
// Odd separators: reported, and nothing is applied.
['1..3', '1~3', '1‐3', '1 → 3', '1 -- 3', '1--3', '1 ... 3', '2 ~ 4 ~ 6'].forEach(function (t) {
  var r = L.parseMarks(t, 8);
  assert.deepStrictEqual([r.wrong, r.knew, r.unread], [[], [], [t]], JSON.stringify(t) + ' is reported and applies nothing');
});
['3 7', '3, 7', '#2, #4', '1-3', '1 - 3', '3.5', '1.2.3', '9/30', '12:30', '2026-10-01', '1,5', '7 & 8'].forEach(function (t) {
  var r = L.parseMarks(t, 8);
  assert.strictEqual(r.unread.length, 0, JSON.stringify(t) + ' is not reported as an odd separator');
});
assert.deepStrictEqual(L.parseMarks('7 ~ 99', 8).unread, [], 'a number past the list makes it a number, not a correction');

/* ============================== 5. capped lines say what was held back ============================== */
var cw = world();
cw.run('2026-09-30');
var t1 = ts(9, 30, 22);
var d1text = cw.run('2026-09-30');
var capped = cw.run('2026-10-01', { dm: { channel: 'D0', text: fenced(t1, d1text) }, dmThread: [{ root: t1, text: fenced(t1, d1text) + NL + ['all', 'everything', '1/3', '9', '0'].map(function (b, i) { return banner(ts(10, 1, 9 + i), b); }).join(NL) }] });
var unreadLines = capped.split(NL).filter(function (l) { return /^NOT READ AS A CORRECTION/.test(l); });
assert.strictEqual(unreadLines.length, 3, 'three lines are shown');
assert.ok(capped.split(NL).indexOf('+ 2 more replies were not read as corrections.') > -1, 'and the rest are counted: ' + capped.split(NL).slice(0, 9).join(' / '));
var one = cw.run('2026-10-02', { dm: { channel: 'D0', text: fenced(t1, d1text) }, dmThread: [{ root: t1, text: fenced(t1, d1text) + NL + ['all', 'everything', '1/3', '9'].map(function (b, i) { return banner(ts(10, 2, 9 + i), b); }).join(NL) }] });
assert.ok(one.split(NL).indexOf('+ 1 more reply was not read as corrections.') > -1, 'singular: ' + one.split(NL).slice(0, 9).join(' / '));
assert.ok(cw.run('2026-10-03').indexOf('more repl') === -1, 'no count when nothing is held back');

// Restore notes: four shown, the rest counted, and a note that was held back has not been said.
var rw = world();
rw.run('2026-09-30');
var led = rw.data();
for (var q = 1; q <= 6; q++) {
  led.restoreLog['aaaa000' + q] = { state: 'applied', reason: null, key: 'gone-' + q, ref: 'bbbb000' + q, requestedAt: '2026-09-30T10:00:00.000Z', on: '2026-09-30', firstSeen: '2026-09-30',
    shown: 0, shownIn: null, shownRefs: [], acked: false, superseded: false };
}
fs.writeFileSync(rw.ledger, JSON.stringify(led));
var notes1 = rw.run('2026-10-01');
var shownLines = notes1.split(NL).filter(function (l) { return /^Restore applied to its record/.test(l); });
assert.strictEqual(shownLines.length, 4, 'four restore notes are shown');
assert.ok(notes1.split(NL).indexOf('+ 2 more restore notes are not shown here. Ask your assistant to list your restore requests.') > -1, 'and the other two are counted: ' + notes1.split(NL).slice(0, 12).join(' / '));
var logAfter = rw.data().restoreLog, carried = Object.keys(logAfter).filter(function (id) { return logAfter[id].shown > 0; });
assert.strictEqual(carried.length, 4, 'only the four that were displayed count as carried');
Object.keys(logAfter).filter(function (id) { return logAfter[id].shown === 0; }).forEach(function (id) { assert.deepStrictEqual(logAfter[id].shownRefs, [], 'a held-back note has no carrier'); });
// That digest is confirmed delivered: it confirms the four it carried, and the two that were held back are the ones still owed.
fs.writeFileSync(path.join(rw.dir, 'status.json'), JSON.stringify({ delivered: { date: '2026-10-01', at: '2026-10-01T20:00:00.000Z', ref: notes1.match(/· ref ([0-9a-f]{4})/)[1] } }));
var notes2 = rw.run('2026-10-02');
var shown2 = notes2.split(NL).filter(function (l) { return /^(Restore applied to its record|Restored earlier)/.test(l); });
assert.strictEqual(shown2.length, 2, 'the next digest carries the two that had not been said');
assert.ok(shown2.every(function (l) { return /^Restore applied to its record/.test(l); }), 'as news, not as repeats: they were never said');
assert.ok(notes2.indexOf('more restore note') === -1);

console.log('follow-ups: OK');
