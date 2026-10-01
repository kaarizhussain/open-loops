/* A read of the DM with nothing new in it comes back from the connector as the channel's header and no messages ("Channel: DM (D0…)" and a blank line: seen on the first
 * real run on the combined code, where it was reported as "your DM read could not be parsed" and the run's input was edited to get past it).
 *
 * That is an empty read, and says nothing. Only a recognised header, and nothing else, counts. Anything else without a message in it is still reported, and the input is
 * never edited. The header here is the observed shape with the identifiers sanitised.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var crypto = require('crypto');
var { main } = require('../slack-run.js');

var NL = String.fromCharCode(10), CRLF = String.fromCharCode(13) + NL, ME = 'alex@example.com', TAB = String.fromCharCode(9);
var WARN = 'CORRECTIONS NOT CHECKED — your DM read could not be parsed, so corrections typed since the last digest were not read.';
var d = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-dmheader-')), cfg = path.join(d, 'c.json');
fs.writeFileSync(cfg, JSON.stringify({ you: ME, selfDm: 'U0EXAMPLE001', tzOffset: 0, spotCheck: 0, ledger: path.join(d, 'l.json'), channels: { include: ['#ops'] } }));
var lena = '=== Message from Lena Borg <lena@vf.example> (U0EXAMPLE002) at 1790000000.000100 UTC ===' + NL + 'Message TS: 1790000000.000100' + NL + 'Thanks all, see you.';
var n = 0;
/* Runs the digest on an input, and returns what it printed and whether the input file came through byte for byte. */
var run = function (extra) {
  var p = path.join(d, 'i' + (n++) + '.json');
  fs.writeFileSync(p, JSON.stringify(Object.assign({ today: '2026-10-01', conversations: [{ channel: '#ops', members: [], text: lena, complete: true }], dm: { channel: 'D0', text: '' } }, extra || {})));
  var before = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
  var out = main([p, '--config', cfg, '--dry']);
  assert.strictEqual(crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'), before, 'the input is never edited');
  return out;
};
var HEADER = 'Channel: DM (D0EXAMPLE001)';

/* ------------------------------ a header and nothing else is an empty read ------------------------------ */
var EMPTY = [
  ['the observed shape: a header and a blank line', HEADER + NL + NL],
  ['no trailing newline', HEADER],
  ['one newline', HEADER + NL],
  ['carriage returns', HEADER + CRLF + CRLF],
  ['blank lines before it', NL + NL + HEADER + NL],
  ['spaces around it', '   ' + HEADER + '   ' + NL],
  ['tabs around it', TAB + HEADER + TAB + NL],
  ['a channel name with spaces', 'Channel: DM with Lena H (D0EXAMPLE001)' + NL + NL],
  ['a group conversation', 'Channel: mpdm-lena--sam--alex-1 (G0EXAMPLE002)' + NL],
  ['a channel id of another kind', 'Channel: DM (C0EXAMPLE003)' + NL],
  ['the header twice', HEADER + NL + NL + HEADER + NL],
  ['only whitespace after it', HEADER + NL + '   ' + NL + TAB + NL]
];
EMPTY.forEach(function (c) {
  var out = run({ dm: { channel: 'D0', text: c[1] } });
  assert.ok(out.indexOf(WARN) === -1, c[0] + ': an empty read says nothing: ' + out.split(NL).slice(0, 5).join(' / '));
  assert.ok(/^OPEN LOOPS — for 2026-10-01/.test(out), c[0] + ': and the digest is produced');
});
// Paged reads, and a thread read, in the same shape (text and pages together is not a valid read at all).
assert.ok(run({ dm: { channel: 'D0', pages: [{ text: HEADER + NL + NL }, { text: HEADER + NL + NL }] } }).indexOf(WARN) === -1, 'pages that are each a header');
assert.ok(run({ dm: undefined, dmThread: [{ root: '1790809082.201339', text: HEADER + NL + NL }] }).indexOf(WARN) === -1, 'a thread read that is only a header');
// The existing empty reads are unchanged.
['', '  ' + NL + ' '].forEach(function (t) { assert.ok(run({ dm: { channel: 'D0', text: t } }).indexOf(WARN) === -1, JSON.stringify(t) + ' says nothing'); });
// A header before real messages is still read as ever.
var withMessage = HEADER + NL + NL + '=== Message from Alex Rivera <' + ME + '> (U0EXAMPLE001) at 1790000100.000100 UTC ===' + NL + 'Message TS: 1790000100.000100' + NL + 'note to self';
assert.ok(run({ dm: { channel: 'D0', text: withMessage } }).indexOf(WARN) === -1, 'a header and a message');

/* ------------------------------ anything else that is not a message is still reported ------------------------------ */
var BAD = [
  ['a header with no id', 'Channel: DM' + NL],
  ['a header with an empty id', 'Channel: DM ()' + NL],
  ['a header with a lower-case id', 'Channel: DM (d0example001)' + NL],
  ['a header whose id is too short', 'Channel: DM (D0EX)' + NL],
  ['a header with words after it on its line', HEADER + ' and more' + NL],
  ['two headers on one line', HEADER + ' Channel: DM (D0EXAMPLE002)' + NL],
  ['a mistyped header', 'Chanel: DM (D0EXAMPLE001)' + NL],
  ['a header that is not at the start of a line', 'x ' + HEADER + NL],
  ['a header and other text', HEADER + NL + NL + 'hello there' + NL],
  ['other text and then a header', 'hello there' + NL + HEADER + NL],
  ['a header and a connector error', HEADER + NL + 'the connector returned an error: rate limited' + NL],
  ['a header and message-like text with no message timestamp', HEADER + NL + NL + '=== Message from Alex Rivera <' + ME + '> (U0EXAMPLE001) at 1790000100.000100 UTC ===' + NL + 'note to self'],
  ['a header and a blank line and a truncated message', HEADER + NL + NL + '=== Message from'],
  ['text with no header at all', 'ratelimited'],
  ['a header-looking line with a space in the id', 'Channel: DM (D0EXAM PLE001)' + NL]
];
BAD.forEach(function (c) {
  var out = run({ dm: { channel: 'D0', text: c[1] } });
  assert.ok(out.indexOf(WARN) > -1, c[0] + ' is still said: ' + out.split(NL).slice(0, 5).join(' / '));
});
assert.ok(run({ dm: { channel: 'D0', pages: [{ text: HEADER + NL }, { text: 'ratelimited' }] } }).indexOf(WARN) > -1, 'a page that is not a header, beside one that is');
assert.ok(run({ dm: undefined, dmThread: [{ root: '1790809082.201339', text: HEADER + NL + 'ratelimited' }] }).indexOf(WARN) > -1, 'a thread read with other text');
// A structured read that is malformed is still reported, as before.
assert.ok(run({ dm: { channel: 'D1', messages: [{ ts: 'x', user: 'U1', text: 'hi' }] } }).indexOf(WARN) > -1);

console.log('dm header: OK');
