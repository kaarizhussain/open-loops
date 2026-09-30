/* Runner findings from the whole-product review:
 *   - an invalid date crashed with "Invalid time value", which names nothing
 *   - a malformed self-DM read threw out of main() and killed the digest; a DM response that was an error sentence passed in silence,
 *     so the run looked like "no corrections typed" and yesterday's rejections were simply not applied
 * An empty DM is a valid read (nothing typed since the digest) and must say nothing.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var { main } = require('../slack-run.js');

var NL = String.fromCharCode(10), ME = 'alex@example.com';
var WARN = 'CORRECTIONS NOT CHECKED — your DM read could not be parsed, so corrections typed since the last digest were not read.';
var d = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-runner-')), cfg = path.join(d, 'c.json');
fs.writeFileSync(cfg, JSON.stringify({ you: ME, selfDm: 'U0EXAMPLE001', tzOffset: 0, spotCheck: 0, ledger: path.join(d, 'l.json'), channels: { include: ['#ops'] } }));
var lena = '=== Message from Lena Borg <lena@vf.example> (U0EXAMPLE002) at 1790000000.000100 UTC ===' + NL + 'Message TS: 1790000000.000100' + NL + 'Thanks all, see you.';
var n = 0;
var run = function (extra, args) {
  var p = path.join(d, 'i' + (n++) + '.json');
  fs.writeFileSync(p, JSON.stringify(Object.assign({ today: '2026-10-01', conversations: [{ channel: '#ops', members: [], text: lena, complete: true }], dm: { channel: 'D0', text: '' } }, extra || {})));
  return main([p, '--config', cfg, '--dry'].concat(args || []));
};

/* ------------------------------ an invalid date names itself ------------------------------ */
assert.throws(function () { run({ today: '2026-9-1' }); }, /^Error: --today must be a real date like 2026-09-30, got "2026-9-1"\.$/);
assert.throws(function () { run({ today: '2026-02-31' }); }, /got "2026-02-31"\./);
assert.throws(function () { run({}, ['--today', 'nope']); }, /^Error: --today must be a real date like 2026-09-30, got "nope"\.$/);
assert.doesNotThrow(function () { run({ today: '2026-10-01' }); }, 'a real date is fine');
assert.doesNotThrow(function () { run({}, ['--today', '2026-10-02']); });

/* ------------------------------ an unreadable DM is said, an empty one is not ------------------------------ */
var brief = function (out) { return out.split('-- thread --')[0]; };
var bad = [
  ['a malformed structured DM', { dm: { channel: 'D1', messages: [{ ts: 'x', user: 'U1', text: 'hi' }] } }],
  ['a connector error sentence', { dm: { channel: 'D1', text: 'the connector returned an error: rate limited' } }],
  ['a malformed structured thread', { dmThread: [{ root: '1788000000.000100', messages: [{ ts: '1788000001.0', user: 'U1' }] }] }],
  ['a thread read that is an error sentence', { dmThread: [{ root: '1788000000.000100', text: 'Error: channel_not_found' }] }],
  ['a DM split into pages, one an error', { dm: { channel: 'D1', pages: [{ text: 'ratelimited' }] } }]
];
bad.forEach(function (c) {
  var out;
  assert.doesNotThrow(function () { out = run(c[1]); }, c[0] + ' no longer kills the digest');
  assert.ok(out.indexOf(WARN) > -1, c[0] + ' is said: ' + out.split(NL).slice(0, 6).join(' / '));
  assert.ok(/\n1 read warning — in the thread\./.test(brief(out)), c[0] + ' is counted in the brief');
});
var fine = [
  ['no DM read', { dm: undefined }],
  ['an empty DM read', { dm: { channel: 'D1', text: '' } }],
  ['whitespace only', { dm: { channel: 'D1', text: '  \n ' } }],
  ['a structured DM with no messages', { dm: { channel: 'D1', messages: [] } }],
  ['a DM holding a message', { dm: { channel: 'D1', text: '=== Message from Alex Rivera <' + ME + '> (U0EXAMPLE001) at 1790000100.000100 UTC ===' + NL + 'Message TS: 1790000100.000100' + NL + 'note to self' } }],
  ['a DM holding only a housekeeping notice', { dm: { channel: 'D1', text: '=== Message from Alex Rivera <' + ME + '> (U0EXAMPLE001) at 1790000100.000100 UTC ===' + NL + 'Message TS: 1790000100.000100' + NL + 'has joined the channel' } }],
  ['an empty thread read', { dmThread: [{ root: '1788000000.000100', text: '' }] }]
];
fine.forEach(function (c) {
  var input = Object.assign({}, c[1]);
  if (c[1].dm === undefined && 'dm' in c[1]) input.dm = undefined;
  var out = run(input);
  assert.ok(out.indexOf('CORRECTIONS NOT CHECKED') < 0, c[0] + ' is a valid read and says nothing: ' + out.split(NL).slice(0, 6).join(' / '));
});

console.log('runner batch: OK');
