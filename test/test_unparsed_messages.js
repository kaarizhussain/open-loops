/* A message whose timestamp cannot be read is dropped by the text parser. That is right for placing it, and wrong for what
 * the run then claimed (codex-debug-review, 2026-10-02): one readable greeting beside a dropped commitment made the read
 * look complete, a DM read with a broken "Message TS:" line passed as read, and a lookup page whose digest was dropped
 * answered NONE — a first run. Each now says the read was not whole.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var { main } = require('../slack-run.js');
var lookup = require('../tools/dm-lookup.js');

var NL = String.fromCharCode(10), ME = 'alex@example.com';
var d = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-unparsed-')), cfg = path.join(d, 'c.json');
fs.writeFileSync(cfg, JSON.stringify({ you: ME, selfUid: 'U0EXAMPLE001', tzOffset: 0, lookbackDays: 21, spotCheck: 0, ledger: path.join(d, 'l.json') }));
var msg = function (ts, body) {
  return '=== Message from Alex Rivera <' + ME + '> (U0EXAMPLE001) at now ===' + NL + 'Message TS: ' + ts + NL + body;
};
var good = msg('1790870400.000001', 'Hello.'), broken = msg('invalid', 'I will send the contract tomorrow.');
var n = 0;
var run = function (input) {
  var p = path.join(d, 'i' + (n++) + '.json');
  fs.writeFileSync(p, JSON.stringify(Object.assign({ today: '2026-10-02' }, input)));
  return main([p, '--config', cfg, '--dry']);
};
var INCOMPLETE = 'INCOMPLETE — #deals: 1 message could not be parsed; completion cannot be verified from missing items.';
var WARN = 'CORRECTIONS NOT CHECKED — your DM read could not be parsed, so corrections typed since the last digest were not read.';

/* ------------------------------ a channel that lost a message is not complete ------------------------------ */
var out = run({ conversations: [{ channel: '#deals', text: good + NL + broken, complete: true }] });
assert.ok(out.indexOf(INCOMPLETE) > -1, 'the lost message is reported: ' + out.split(NL).slice(0, 4).join(' / '));
assert.ok(out.indexOf('Nothing outstanding') === -1, 'and the empty list is not called clear');
assert.ok(/read incomplete/.test(out.split(NL)[1]), 'the brief says the read was incomplete');
// Paged, the count is carried across pages.
out = run({ conversations: [{ channel: '#deals', pages: [{ text: good, pagination_info: 'There are no more messages' }, { text: broken }] }] });
assert.ok(out.indexOf(INCOMPLETE) > -1, 'a lost message on a later page is reported');
// Two lost: the count is right.
out = run({ conversations: [{ channel: '#deals', text: good + NL + broken + NL + msg('', 'Also the deck.'), complete: true }] });
assert.ok(out.indexOf('#deals: 2 messages could not be parsed') > -1, 'two lost messages are counted');
// A clean read, and a join notice with no timestamp, are unchanged.
out = run({ conversations: [{ channel: '#deals', text: good, complete: true }] });
assert.ok(out.indexOf('could not be parsed') === -1 && out.indexOf('INCOMPLETE') === -1, 'a clean read says nothing');
// (a notice with no timestamp line at all: with a broken one, the junk line is part of the body and it is no longer the whole message)
var noTs = '=== Message from Alex Rivera <' + ME + '> (U0EXAMPLE001) at now ===' + NL + '<@U0EXAMPLE002|Lena H> has joined the channel';
out = run({ conversations: [{ channel: '#deals', text: good + NL + noTs, complete: true }] });
assert.ok(out.indexOf('could not be parsed') === -1, 'a housekeeping notice is not a lost message');

/* ------------------------------ a DM read that lost a message is a correction not read ------------------------------ */
out = run({ conversations: [{ channel: '#deals', text: good, complete: true }], dm: { text: broken } });
assert.ok(out.indexOf(WARN) > -1, 'a DM message with a broken timestamp is reported');
out = run({ conversations: [{ channel: '#deals', text: good, complete: true }], dm: { text: good + NL + broken } });
assert.ok(out.indexOf(WARN) > -1, 'even beside one that was read');
out = run({ conversations: [{ channel: '#deals', text: good, complete: true }], dm: { text: good } });
assert.ok(out.indexOf(WARN) === -1, 'a clean DM read says nothing');

/* ------------------------------ a lookup page that lost a message cannot answer NONE or FOUND ------------------------------ */
var page = function (obj) { var f = path.join(d, 'p' + (n++) + '.json'); fs.writeFileSync(f, JSON.stringify(obj)); return f; };
var ask = function (text) {
  return lookup.main(['--page', page({ text: text, pagination_info: 'There are no more messages' }), '--number', '1', '--today', '2026-10-02', '--config', cfg]);
};
var UNREADABLE = 'UNREADABLE — a message on this page could not be parsed, and it may be the earlier digest.\ndmLookup: failed';
assert.strictEqual(ask(msg('invalid', 'OPEN LOOPS — for 2026-10-01 · ref abcd')), UNREADABLE, 'a dropped digest is not a first run');
assert.strictEqual(ask(msg('invalid', 'OPEN LOOPS — for 2026-10-01 · ref abcd') + NL + msg('1790700000.000001', 'OPEN LOOPS — for 2026-09-30 · ref 1234')),
  UNREADABLE, 'nor is an older digest found beside it trusted');
assert.ok(/^NONE/.test(ask(good)), 'a clean page with no digest is still NONE');
assert.ok(/^FOUND ts=1790700000.000001 date=2026-09-30 ref=1234/.test(ask(msg('1790700000.000001', 'OPEN LOOPS — for 2026-09-30 · ref 1234'))), 'and a clean digest is still FOUND');

fs.rmSync(d, { recursive: true, force: true });
console.log('unparsed messages: OK');
