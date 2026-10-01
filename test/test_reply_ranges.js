/* Replies: ranges, and corrections that cannot be read.
 *
 * Before: "1-3" and "1/3" and "all" produced nothing at all, and "1 to 3" rejected only items 1 and 3, so the reader waited for a change that
 * never came or got half of one. Now an inclusive range ("1-3", "1–3", "1 to 3", "1 through 3") is every item in it; a line that looks like a
 * correction and cannot be read as one ("all", "1/3", a reversed range, a range past the end of the list) is reported and applies nothing;
 * ordinary conversation with numbers in it is left alone; and the guard against a reply that rejects most of the list is unchanged.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var L = require('../src/ledger.js');
var { main, marksFromDm } = require('../slack-run.js');

var NL = String.fromCharCode(10), ME = 'alex@example.com';

/* ------------------------------ 1. every reply form, on a list of 8 ------------------------------ */
var read = function (t) { var r = L.parseMarks(t, 8); return { wrong: r.wrong, knew: r.knew, ignored: r.ignored.length, unread: r.unread.length }; };
var R = function (wrong, extra) { return Object.assign({ wrong: wrong, knew: [], ignored: 0, unread: 0 }, extra || {}); };
var TABLE = [
  // Ranges, every spelling, are inclusive.
  ['1-3', R([1, 2, 3])], ['1–3', R([1, 2, 3])], ['1—3', R([1, 2, 3])], ['1 - 3', R([1, 2, 3])], ['1 to 3', R([1, 2, 3])], ['1 through 3', R([1, 2, 3])],
  ['1 thru 3', R([1, 2, 3])], ['#2-#4', R([2, 3, 4])], ['5-5', R([5])], ['1-8', R([1, 2, 3, 4, 5, 6, 7, 8])],
  // Beside other marks, once each.
  ['1-3 and 5', R([1, 2, 3, 5])], ['1-3, 7', R([1, 2, 3, 7])], ['7, 1-3', R([7, 1, 2, 3])], ['2-4 3', R([2, 3, 4])], ['1-3\n2-5', R([1, 2, 3, 4, 5])],
  ['3 7', R([3, 7])], ['3', R([3])], ['3, 7', R([3, 7])], ['#3, #7 please', R([3, 7])],
  // After a k, they mean "already known".
  ['k 1-3', R([], { knew: [1, 2, 3] })], ['knew 2 to 4', R([], { knew: [2, 3, 4] })],
  // A range that cannot be read applies NOTHING from its line — not its endpoints, not the valid-looking numbers beside it.
  ['3-1', R([], { unread: 1 })], ['1-9', R([], { unread: 1 })], ['0-3', R([], { unread: 1 })], ['9-12', R([], { unread: 1 })],
  ['1-3 9-2', R([], { unread: 1 })], ['3 7 and 9-2', R([], { unread: 1 })], ['1 2 5-99', R([], { unread: 1 })], ['1 - 3 - 5', R([], { unread: 1 })],
  ['k 3-1', R([], { unread: 1 })], ['1 to 99', R([], { unread: 1 })],
  // The rest of the reply is still read.
  ['1\n3-1', R([1], { unread: 1 })], ['3-1\n4', R([4], { unread: 1 })],
  // Correction-shaped, unreadable: reported, not applied.
  ['all', R([], { unread: 1 })], ['All', R([], { unread: 1 })], ['all of them', R([], { unread: 1 })], ['everything', R([], { unread: 1 })],
  ['reject all', R([], { unread: 1 })], ['all.', R([], { unread: 1 })], ['1/3', R([], { unread: 1 })], ['1-3-5', R([], { unread: 1 })],
  ['9', R([], { unread: 1 })], ['0', R([], { unread: 1 })], ['9 10', R([], { unread: 1 })],
  // Ordinary conversation: not a correction, and not newly noisy.
  ['all good thanks', R([])], ['all set', R([])], ['thanks!', R([])], ['none', R([])], ['', R([])], ['ok', R([])], ['all done with item', R([])],
  ['9/30 standup', R([])], ['2026-10-01', R([])], ['3:30', R([])], ['1-3pm', R([])], ['room 3-9', R([])], ['see pages 2-5', R([])],
  ['version 1.2.3', R([])], ['3.5 hours', R([])], ['12 people came', R([])],
  // Notes that name a number but do not lead with one: reported as before, applied never.
  ['3pm call moved to 4', R([], { ignored: 1 })], ['call me at 3', R([], { ignored: 1 })], ['call Dana, items 1-3', R([])]
];
TABLE.forEach(function (c) { assert.deepStrictEqual(read(c[0]), c[1], JSON.stringify(c[0])); });

// The ranges a reply used are returned so the digest can name them.
assert.deepStrictEqual(L.parseMarks('1-3 and 5', 8).ranges, { wrong: [[1, 3]], knew: [] });
assert.deepStrictEqual(L.parseMarks('k 2 to 4', 8).ranges, { wrong: [], knew: [[2, 4]] });
assert.deepStrictEqual(L.parseMarks('3 7', 8).ranges, { wrong: [], knew: [] }, 'single numbers name no range');
assert.deepStrictEqual(L.parseMarks('1-9', 8).ranges, { wrong: [], knew: [] }, 'and a range that was not read names none');
// Nothing is read as a correction when there is no list to refer to.
assert.deepStrictEqual(L.parseMarks('1-3', 0).wrong, []);
assert.strictEqual(L.parseMarks('1-3', 0).unread.length, 0, 'with no list, a range is only conversation');
assert.strictEqual(L.parseMarks('all', 0).unread.length, 0);

/* ------------------------------ 2. a range is checked against the list before it is expanded ------------------------------ */
var huge = ['1-999999999999', '1-99999999999999999999999', '0-999999999999', '5-4294967296', '1 to 18446744073709551616'];
var t0 = Date.now();
huge.forEach(function (t) {
  var r = L.parseMarks(t, 8);
  assert.deepStrictEqual(r.wrong, [], t + ' applies nothing');
  assert.strictEqual(r.unread.length, 1, t + ' is reported');
});
assert.ok(Date.now() - t0 < 500, 'and nothing was allocated to find that out');
// Even a list of 8 can never yield more than 8 marks, however a line is written.
['1-8 1-8 1-8', '1-8, 2-7, 1-8', '8-8, 1-8'].forEach(function (t) { assert.ok(L.parseMarks(t, 8).wrong.length <= 8, t); });

/* ------------------------------ 3. the mass-reply guard applies to the expanded list ------------------------------ */
var keys = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8'];
var store = {
  seenReplies: function () { return []; }, refsSince: function () { return '2026-09-22'; },
  recallRef: function (r) { return r === 'cccc' ? { date: '2026-09-23', keys: keys, asked: [] } : null; }
};
var rowsOf = function () { return keys.map(function (k) { return [k, '2026-09-01', '2026-09-23', '', 'owed_by_us', '', '', '']; }); };
var head = { id: '100.1', threadId: '100.1', body: 'OPEN LOOPS — for 2026-09-23 · ref cccc' + NL + 'x' };
var reply = function (body) {
  var rows = rowsOf(), r = marksFromDm([head, { id: '200.1', threadId: 'DM', body: body }], store, rows);
  return { rejected: rows.filter(function (x) { return x[7] === 'x'; }).length, r: r, rows: rows };
};
var all8 = reply('1-8');
assert.strictEqual(all8.rejected, 0, 'a range over the whole list is not applied');
assert.strictEqual(all8.r.mass.length, 1, 'it is reported as the mass-reply guard reports it');
assert.strictEqual(reply('1-5').rejected, 0, '1-5 is 5 of 8: more than half');
assert.strictEqual(reply('1-5').r.mass.length, 1);
assert.strictEqual(reply('1 to 6').rejected, 0, 'in any spelling');
assert.strictEqual(reply('1-3, 5-6').rejected, 0, 'two ranges together are counted together: 5 of 8');
assert.strictEqual(reply('1-4').rejected, 4, '1-4 is 4 of 8, which is not more than half: it is a correction');
assert.strictEqual(reply('1-3').rejected, 3, 'and 1-3 is as ever');
assert.strictEqual(reply('1 2 3 4 5').rejected, 0, 'a list of single numbers is held to the same guard');
var three = reply('1-3');
assert.deepStrictEqual(three.r.rangesWrong, [[1, 3]], 'the range is carried to the digest');
// A line that cannot be read applies nothing and is carried to the digest.
var bad = reply('3 7 and 9-2');
assert.strictEqual(bad.rejected, 0, 'a bad range rejects nothing, including the valid-looking numbers beside it');
assert.deepStrictEqual(bad.r.unread, ['3 7 and 9-2']);
assert.strictEqual(bad.r.marked, 0);
assert.ok(bad.r.seen.indexOf('200.1') > -1, 'and the reply is read once: it is not re-read tomorrow');
var allReply = reply('all');
assert.strictEqual(allReply.rejected, 0);
assert.deepStrictEqual(allReply.r.unread, ['all']);
var half = reply('2\n9-1');
assert.strictEqual(half.rejected, 1, 'the readable line of a reply is applied');
assert.deepStrictEqual(half.r.unread, ['9-1']);

/* ------------------------------ 4. what the reader is told ------------------------------ */
var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-ranges-')), cfg = path.join(dir, 'c.json');
fs.writeFileSync(cfg, JSON.stringify({ you: ME, selfDm: 'U0EXAMPLE001', tzOffset: 0, spotCheck: 0, ledger: path.join(dir, 'l.json'), channels: { include: ['#ops'] } }));
var at = function (mo, day, h) { return (Date.UTC(2026, mo - 1, day, h) / 1000).toFixed(6); };
var banner = function (ts, body, who) {
  return '=== Message from Lena Borg <lena@vf.example> (U0EXAMPLE002) at ' + ts + ' UTC ===' + NL + 'Message TS: ' + ts + NL + body;
};
var chat = ['alpha', 'bravo', 'charlie'].map(function (w, i) { return banner(at(9, 25 + i, 10), 'Please send the ' + w + ' report Thursday Oct 1.'); }).join(NL);
var n = 0;
var input = function (today, extra) {
  var p = path.join(dir, 'in' + (n++) + '.json');
  fs.writeFileSync(p, JSON.stringify(Object.assign({ today: today, conversations: [{ channel: '#ops', members: [], text: chat, complete: true }], dm: { channel: 'D0', text: '' } }, extra || {})));
  return p;
};
var first = main([input('2026-09-30'), '--config', cfg]);
var ts1 = at(9, 30, 22);
var threadOf = function (replies) {
  return [{ root: ts1, text: banner(ts1, '```' + NL + first + NL + '```') + NL + replies.map(function (t, i) { return banner(at(10, 1, 9 + i), t); }).join(NL) }];
};
var snapshot = fs.readFileSync(path.join(dir, 'l.json'), 'utf8');
var rejectedNow = function () { return JSON.parse(fs.readFileSync(path.join(dir, 'l.json'), 'utf8')).rows.filter(function (r) { return r[L.COL.verdict]; }).length; };

var ranged = main([input('2026-10-01', { dm: { channel: 'D0', text: banner(ts1, '```' + NL + first + NL + '```') }, dmThread: threadOf(['1-2']) }), '--config', cfg]);
assert.ok(/^Took your last reply — 2 marked not real \(1–2\), dropped for good\.$/m.test(ranged), ranged.split(NL).slice(0, 8).join(' / '));
assert.strictEqual(rejectedNow(), 2, 'and both items were rejected, not just the endpoints of the range');

fs.writeFileSync(path.join(dir, 'l.json'), snapshot);
var unreadOut = main([input('2026-10-02', { dm: { channel: 'D0', text: banner(ts1, '```' + NL + first + NL + '```') }, dmThread: threadOf(['all', '1/3', '3-1']) }), '--config', cfg]);
['all', '1/3', '3-1'].forEach(function (t) {
  assert.ok(unreadOut.indexOf('NOT READ AS A CORRECTION — "' + t + '". Reply with the numbers that are not real, like "3 7", or a range like "1-3".') > -1, t + ': ' + unreadOut.split(NL).slice(0, 10).join(' / '));
});
assert.ok(!/Took your last reply/.test(unreadOut), 'and nothing was applied');
assert.strictEqual(rejectedNow(), 0, 'the ledger rejects nothing');

fs.writeFileSync(path.join(dir, 'l.json'), snapshot);
var talk = main([input('2026-10-03', { dm: { channel: 'D0', text: banner(ts1, '```' + NL + first + NL + '```') }, dmThread: threadOf(['9/30 standup, 4 people', 'all good thanks', 'thanks!']) }), '--config', cfg]);
assert.ok(!/NOT READ AS A CORRECTION|Took your last reply/.test(talk), 'ordinary conversation is not reported and not applied: ' + talk.split(NL).slice(0, 8).join(' / '));

console.log('reply ranges: OK');
