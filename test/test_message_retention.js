/* Real messages are not discarded for looking like connector furniture (adversarial review 2026-10-05, Codex finding 5 and the parsing pass's A2/A4/A5).
 *
 * The adapters dropped a message whole when its body merely ENDED with a notice phrase ("... after Sana has joined the channel"), when one of its
 * lines began like the connector's own thread note, footer or file line, and when its words lived in attachments or blocks rather than `text`. A
 * dropped message never reaches the detector, so a real commitment vanished and the digest said "Nothing outstanding". Now: a notice is a message
 * that IS the notice (or has a notice subtype), the connector's lines are recognised only in the connector's own shape, and attachment and block
 * text is read; a message that has such structure and yields nothing is counted as one that could not be parsed.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var slack = require('../src/slack.js');
var sj = require('../src/slack-json.js');
var { main } = require('../slack-run.js');

var NL = String.fromCharCode(10), ME = 'alex@example.com';
var banner = function (ts, body) { return '=== Message from Pat Lee <pat@example.com> (U0EXAMPLE002) at now ===' + NL + 'Message TS: ' + ts + NL + body; };
var text = function (body) { return slack.parseChannel(banner('1790870400.000001', body), { channel: '#c', self: ME }); };
var bodies = function (ms) { return ms.map(function (m) { return m.body; }); };

/* ------------------------------ the text adapter ------------------------------ */
// A real notice is dropped, a sentence that only ends with one is kept.
['<@U0EXAMPLE003|Sana> has joined the channel', '<@U0EXAMPLE003> has left the channel', 'set the channel topic: Q4 launch', 'You pinned a message.', 'added an integration to this channel: Zapier']
  .forEach(function (n) { assert.deepStrictEqual(bodies(text(n)), [], 'a notice is dropped: ' + n); });
[ 'I will send the contract tomorrow after Sana has joined the channel',          // the review's own sentence
  'I will send the deck Friday, once Sana has left the channel',
  "I'll send the agenda Friday and I've pinned a message",
  'Sana has joined the channel, so I will send her the onboarding pack Thursday'
].forEach(function (s) { assert.deepStrictEqual(bodies(text(s)), [s], 'a real message is kept: ' + s); });
assert.strictEqual(text('I will send the contract tomorrow after Sana has joined the channel').dropped.length, 0, 'and is not counted as dropped');

// The connector's thread note is a whole line of one shape; a sentence that begins like it is text.
var withNote = text("Thanks all" + NL + 'Thread: 2 replies (latest: 2026-09-21 17:42:55 EDT)');
assert.deepStrictEqual([bodies(withNote), withNote[0].hasThread, withNote[0].replyCount], [['Thanks all'], true, 2], 'the real thread note still marks a thread, with its count');
var sentence = text("Thread: 3 replies so far, I'll send the summary Friday");
assert.deepStrictEqual([bodies(sentence), sentence[0].hasThread], [["Thread: 3 replies so far, I'll send the summary Friday"], false], 'a sentence beginning "Thread: 3 replies" is text');
// The app footer is stripped in its own shape only.
assert.deepStrictEqual(bodies(text('Sending it now.' + NL + '*Sent using* <@U0EXAMPLE009|Claude>')), ['Sending it now.'], 'the connector footer is not content');
assert.deepStrictEqual(bodies(text("Sent via email yesterday; I'll resend the invoice Friday")), ["Sent via email yesterday; I'll resend the invoice Friday"], 'a sentence that begins "Sent via" is text');
// A "Files:" line after other text is more text; as the first line it is still the upload marker.
assert.deepStrictEqual(bodies(text("Done with the review." + NL + "Files: I'll upload the signed copy tomorrow")), ["Done with the review." + NL + "Files: I'll upload the signed copy tomorrow"], 'a Files: line after text is kept');
var upload = text('Files: board-deck.pdf');
assert.deepStrictEqual([upload.length, upload[0].attach], [1, true], 'a Files: line with nothing before it is still the attachment marker');

/* ------------------------------ the structured adapter ------------------------------ */
var rec = function (extra) { return Object.assign({ ts: '1790870400.000001', user: 'U0EXAMPLE002', text: 'x' }, extra); };
var parse = function (ms) { return sj.parseMessages(ms, { channel: '#c' }); };
assert.deepStrictEqual(bodies(parse([rec({ text: '<@U0EXAMPLE003> has joined the channel', subtype: 'channel_join' })])), [], 'a notice subtype is dropped');
assert.deepStrictEqual(bodies(parse([rec({ text: 'A topic nobody asked about', subtype: 'channel_topic' })])), [], 'whatever its text');
assert.deepStrictEqual(bodies(parse([rec({ text: 'I will send the contract tomorrow after Sana has joined the channel' })])), ['I will send the contract tomorrow after Sana has joined the channel'], 'a sentence ending with a notice phrase is kept');
// Words in attachments and blocks.
assert.deepStrictEqual(bodies(parse([rec({ user: undefined, bot_id: 'B0EXAMPLE01', subtype: 'bot_message', text: '', attachments: [{ text: "I'll send the signed contract Friday" }] })])), ["I'll send the signed contract Friday"], 'a bot message whose words are in an attachment');
assert.deepStrictEqual(bodies(parse([rec({ text: '', blocks: [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: "I'll send the contract Friday" }] }] }] })])), ["I'll send the contract Friday"], 'a message whose words are in rich-text blocks');
assert.deepStrictEqual(bodies(parse([rec({ text: 'Plain text wins', attachments: [{ text: 'and the attachment is ignored' }] })])), ['Plain text wins'], 'text, when there is any, is what it says');
// Structure with nothing readable is counted; a message with no structure is just empty.
var unreadable = parse([rec({ text: '', blocks: [{ type: 'divider' }] })]);
assert.deepStrictEqual([unreadable.length, unreadable.unparsed], [0, 1], 'a message with blocks and no words is counted as not read');
assert.strictEqual(parse([rec({ text: '', attachments: [{ image_url: 'https://example.com/x.png' }] })]).unparsed, 1, 'so is an attachment with no words');
assert.strictEqual(parse([rec({ text: '' })]).unparsed, 0, 'an empty message with no structure is nothing to read');
assert.strictEqual(parse([rec({ text: '', attachments: [], blocks: [] })]).unparsed, 0, 'and so is one with empty lists');

/* ------------------------------ through the digest ------------------------------ */
var d = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-retain-'));
var cfg = path.join(d, 'c.json');
fs.writeFileSync(cfg, JSON.stringify({ you: ME, selfUid: 'U0EXAMPLE001', tzOffset: 0, lookbackDays: 30, spotCheck: 0, ledger: path.join(d, 'l.json') }));
var n = 0, run = function (messages) {
  var p = path.join(d, 'in' + (n++) + '.json');
  fs.writeFileSync(p, JSON.stringify({ today: '2026-10-05', conversations: [{ channel: '#ops', messages: messages, complete: true }], dm: { messages: [] }, dmLookup: 'searched_none' }));
  return main([p, '--config', cfg, '--dry']);
};
var greet = { ts: '1790870400.000001', user: 'U0EXAMPLE002', text: 'Hi team' };
var out = run([greet, { ts: '1790870500.000001', user: 'U0EXAMPLE001', text: 'I will send the signed contract tomorrow after Sana has joined the channel' }]);
assert.ok(/signed contract/.test(out) && out.indexOf('Nothing outstanding. Genuinely') === -1, 'the review sentence reaches the digest: ' + out.split(NL).slice(0, 5).join(NL));
out = run([greet, { ts: '1790870500.000001', user: 'U0EXAMPLE001', text: '', attachments: [{ text: "I'll send the signed contract Friday" }] }]);
assert.ok(/signed contract Friday/.test(out), 'a commitment held in an attachment reaches the digest');
out = run([greet, { ts: '1790870500.000001', user: 'U0EXAMPLE001', text: '', blocks: [{ type: 'divider' }] }]);
assert.ok(out.indexOf('INCOMPLETE — #ops: 1 message could not be parsed; completion cannot be verified from missing items.') > -1 && out.indexOf('Nothing outstanding. Genuinely') === -1, 'an unreadable message makes the read incomplete');

fs.rmSync(d, { recursive: true, force: true });
console.log('message retention: OK');
