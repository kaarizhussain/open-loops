/* Parsing and reply-marking findings from the whole-product review, each with the input that failed.
 *   - a line of message text that starts "Time:" was dropped as if it were the connector's own
 *   - a timestamp past the range of a date crashed the parse
 *   - "&amp;lt;" was decoded twice
 *   - the structured path kept join/leave notices the text path drops
 *   - a byte-order mark made a valid ledger or config "unreadable"
 *   - a note that starts with a digit ("3pm call moved to 4") rejected item 4
 *   - every standalone letter on a "miss" line counted as a missed message
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var slack = require('../src/slack.js');
var sj = require('../src/slack-json.js');
var L = require('../src/ledger.js');
var { fileStore } = require('../src/store.js');
var { settings, loadConfig } = require('../src/config.js');

var NL = String.fromCharCode(10), BOM = String.fromCharCode(0xFEFF);
var banner = function (ts, body) { return '=== Message from Lena Borg <lena@vf.example> (U0EXAMPLE002) at ' + ts + ' UTC ===' + NL + 'Message TS: ' + ts + NL + body; };
var bodies = function (ms) { return ms.map(function (m) { return m.body; }); };

/* ------------------------------ a line of text that starts "Time:" is text ------------------------------ */
assert.deepStrictEqual(bodies(slack.parseChannel(banner('1790000000.000100', "I can do it." + NL + "Time: 3pm Thursday works, I'll send the deck then"), { channel: '#c' })),
  ["I can do it." + NL + "Time: 3pm Thursday works, I'll send the deck then"], 'a channel read has no Time line of its own, so none is dropped');
assert.deepStrictEqual(bodies(slack.parseChannel(banner('1790000000.000100', "Time: 3pm Thursday works, I'll send the deck then"), { channel: '#c' })),
  ["Time: 3pm Thursday works, I'll send the deck then"], 'even as the first line');
// The connector's own Time line in a thread read still goes: it comes before "Message TS", and the text after it is kept.
var thread = ['=== THREAD PARENT MESSAGE ===', 'From: Lena Borg <lena@vf.example> (U0EXAMPLE002)', 'Time: 2026-09-01 18:00:00 UTC', 'Message TS: 1790000000.000100',
  "Time: Thursday at 3 suits me, I'll send it", '', '=== THREAD REPLIES (1 total) ===', '', '--- Reply 1 of 1 ---', 'From: Lena Borg <lena@vf.example> (U0EXAMPLE002)',
  'Time: 2026-09-01 19:00:00 UTC', 'Message TS: 1790000100.000100', 'ok'].join(NL);
assert.deepStrictEqual(bodies(slack.parseChannel(thread, { channel: '#c', threadId: '1790000000.000100' })), ["Time: Thursday at 3 suits me, I'll send it", 'ok'],
  "the connector's header line is dropped, what the person typed is not");

/* ------------------------------ a timestamp outside the range of a date does not crash the parse ------------------------------ */
assert.doesNotThrow(function () { slack.parseChannel(banner('99999999999999999999.0', 'hello') + NL + banner('1790000000.000100', 'still here'), { channel: '#c' }); });
assert.deepStrictEqual(bodies(slack.parseChannel(banner('99999999999999999999.0', 'hello') + NL + banner('1790000000.000100', 'still here'), { channel: '#c' })), ['still here'],
  'the unplaceable message is dropped and the rest is read');
assert.doesNotThrow(function () { slack.parseChannel(banner('8640000000000.0', 'edge') , { channel: '#c', tzOffset: 600 }); });

/* ------------------------------ entities are decoded once ------------------------------ */
assert.strictEqual(slack.cleanText('use &amp;lt;b&amp;gt; tags'), 'use &lt;b&gt; tags', 'a typed "&lt;" stays what was typed');
assert.strictEqual(slack.cleanText('&amp;amp;'), '&amp;');
assert.strictEqual(slack.cleanText('a &lt; b &amp;&amp; c &gt; d'), 'a < b && c > d', 'and real entities are still decoded');

/* ------------------------------ the structured path drops housekeeping notices too ------------------------------ */
var structured = [{ ts: '1790000000.000100', user: 'U0EXAMPLE002', text: '<@U0EXAMPLE002> has joined the channel', subtype: 'channel_join' },
  { ts: '1790000001.000100', user: 'U0EXAMPLE002', text: "Sana has joined the channel, so I'll send her the onboarding pack Thursday" },
  { ts: '1790000002.000100', user: 'U0EXAMPLE002', text: 'set the channel topic' }];
assert.deepStrictEqual(bodies(sj.parseMessages(structured, { channel: '#c' })), ["Sana has joined the channel, so I'll send her the onboarding pack Thursday"],
  'notices go, a commitment that merely mentions one stays');
assert.deepStrictEqual(bodies(slack.parseChannel(banner('1790000000.000100', 'has joined the channel'), { channel: '#c' })), [], 'the text path agrees');

/* ------------------------------ a byte-order mark is not damage ------------------------------ */
var d = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-parse-'));
fs.writeFileSync(path.join(d, 'l.json'), BOM + JSON.stringify({ rows: [['k', '2026-09-01', '2026-09-01', '', 'owed_by_us', 'you', 'send it', '']] }));
assert.strictEqual(fileStore(path.join(d, 'l.json')).readLedger().length, 1, 'a ledger saved with a byte-order mark is read');
fs.writeFileSync(path.join(d, 'c.json'), BOM + JSON.stringify({ you: 'a@b.co', channels: { include: ['#ops'] } }));
assert.deepStrictEqual(loadConfig(fs, path.join(d, 'c.json')).channels.include, ['#ops']);
assert.strictEqual(settings(fs, path.join(d, 'c.json'), {}).you, 'a@b.co', 'and so is a config');
fs.writeFileSync(path.join(d, 'bad.json'), BOM + '{ not json');
assert.throws(function () { loadConfig(fs, path.join(d, 'bad.json')); }, /could not be read/, 'real damage is still damage');

/* ------------------------------ a reply must lead with a mark, not just a digit ------------------------------ */
var marks = function (t, max) { var r = L.parseMarks(t, max || 10); return { wrong: r.wrong, knew: r.knew, ignored: r.ignored.length }; };
['3pm call with Dana moved to 4', '9/30 standup, 4 people', '3.5 hours with 2 clients', '2026-09-30 notes: item 4', '1password reset, 6 accounts', '12 people came, 3 left', '0 items, 4'].forEach(function (t) {
  assert.deepStrictEqual(marks(t), { wrong: [], knew: [], ignored: 1 }, JSON.stringify(t) + ' rejects nothing and is reported as not read');
});
assert.deepStrictEqual(marks('3 7'), { wrong: [3, 7], knew: [], ignored: 0 });
assert.deepStrictEqual(marks('3, 7'), { wrong: [3, 7], knew: [], ignored: 0 });
assert.deepStrictEqual(marks('#3 and 7'), { wrong: [3, 7], knew: [], ignored: 0 });
assert.deepStrictEqual(marks('4'), { wrong: [4], knew: [], ignored: 0 });
assert.deepStrictEqual(marks('k 1 4'), { wrong: [], knew: [1, 4], ignored: 0 });
assert.deepStrictEqual(marks('k 3pm 4'), { wrong: [], knew: [], ignored: 1 }, 'the same rule after a k');
assert.deepStrictEqual(marks('call Dana at 3'), { wrong: [], knew: [], ignored: 1 }, 'the original rule still holds');
assert.deepStrictEqual(marks('11 7', 10), { wrong: [], knew: [], ignored: 1 }, 'a lead outside the list is not a mark');

/* ------------------------------ a miss line names letters, not words ------------------------------ */
var miss = function (t) { var r = L.parseMarks(t, 10); return { missed: r.missed, answered: r.answered }; };
assert.deepStrictEqual(miss('miss'), { missed: [], answered: true });
assert.deepStrictEqual(miss('miss: none'), { missed: [], answered: true });
assert.deepStrictEqual(miss('miss b d'), { missed: ['b', 'd'], answered: true });
assert.deepStrictEqual(miss('miss b, d'), { missed: ['b', 'd'], answered: true });
assert.deepStrictEqual(miss('miss b and d'), { missed: ['b', 'd'], answered: true });
assert.deepStrictEqual(miss('m c'), { missed: ['c'], answered: true });
assert.deepStrictEqual(miss('miss a'), { missed: ['a'], answered: true }, 'a real "a" is still a letter');
assert.deepStrictEqual(miss('miss b d because both had dates'), { missed: ['b', 'd'], answered: true }, 'prose after the letters is prose');
assert.deepStrictEqual(miss('miss none, a clean sample'), { missed: [], answered: true }, '"a" in a sentence is not a miss');
assert.deepStrictEqual(miss('missed a couple? no, none'), { missed: [], answered: true });
assert.deepStrictEqual(miss('miss I think so'), { missed: [], answered: true }, '"I" in a sentence is not a miss');

console.log('parsing batch: OK');
