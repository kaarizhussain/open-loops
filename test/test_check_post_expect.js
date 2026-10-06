/* The read-back is compared with what the runner printed (2026-10-06, after the first digest on the adversarial fixes).
 *
 * `--check-post <file>` checked only that the message was one code block, and the run applied it to files it had BUILT from its own runner output, which proves nothing
 * about what Slack returned. It now also takes `--expect <the runner output file> --part brief|details` and compares the text that came back, character for character,
 * with that part of the runner output. Every case is synthetic: nothing here reads or posts anything.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');
var { main } = require('../slack-run.js');

var NL = String.fromCharCode(10), CR = String.fromCharCode(13), ZW = String.fromCharCode(0x200b), FENCE = '```', ME = 'alex@example.com';
var d = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-expect-'));
var cfg = path.join(d, 'openloops.config.json');
fs.writeFileSync(cfg, JSON.stringify({ you: ME, selfUid: 'U0EXAMPLE001', tzOffset: 0, lookbackDays: 30, spotCheck: 0, ledger: 'ledger.json' }));
var input = path.join(d, 'in.json');
fs.writeFileSync(input, JSON.stringify({ today: '2026-10-05', conversations: [{ channel: '#ops', complete: true, messages: [
  { ts: '1790870400.000001', user: 'U0EXAMPLE001', text: 'I will send ``` contract tomorrow.' },
  { ts: '1790870500.000001', user: 'U0EXAMPLE001', text: "I'll book the offsite venue by Friday." }] }], dm: { messages: [] }, dmLookup: 'searched_none' }));
var output = main([input, '--config', cfg, '--dry']);
var outFile = path.join(d, 'output.txt');
fs.writeFileSync(outFile, output);
var parts = output.split(/^-- thread --$/m).map(function (p) { return p.trim(); });
assert.strictEqual(parts.length, 2, 'a brief and its details');
assert.ok(parts[0].indexOf(ZW) > -1 || parts[1].indexOf(ZW) > -1, 'and the quoted fence was written with the protective space');

var n = 0;
var run = function (text, part, expectFile) {
  var f = path.join(d, 'rb' + (n++) + '.txt');
  fs.writeFileSync(f, text);
  var args = ['--check-post', f];
  if (part) args.push('--expect', expectFile || outFile, '--part', part);
  var r = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'slack-run.js')].concat(args), { encoding: 'utf8' });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};
// The message as the connector returns it: the opening fence runs straight into the first line (the newline after it is not returned).
var asReturned = function (body) { return FENCE + body + FENCE; };
// The message as it was sent: a newline after the opening fence and before the closing one.
var asSent = function (body) { return FENCE + NL + body + NL + FENCE; };

/* ------------------------------ identical text passes, in the shapes it really comes back in ------------------------------ */
['brief', 'details'].forEach(function (part, k) {
  var body = parts[k];
  [['as the connector returns it', asReturned(body)], ['as it was sent', asSent(body)],
   ['with carriage returns', asSent(body).split(NL).join(CR + NL)], ['with whitespace around the message', NL + '  ' + asSent(body) + NL + NL],
   ['with a byte-order mark', String.fromCharCode(0xfeff) + asSent(body)]
  ].forEach(function (c) {
    var r = run(c[1], part);
    assert.deepStrictEqual([r.status, r.out], [0, 'Post OK.'], part + ' ' + c[0] + ': ' + r.err);
  });
});
// The saved runner output may itself have carriage returns or a byte-order mark (PowerShell's redirect adds both).
var windowsOut = path.join(d, 'windows.txt');
fs.writeFileSync(windowsOut, String.fromCharCode(0xfeff) + output.split(NL).join(CR + NL));
assert.strictEqual(run(asSent(parts[0]), 'brief', windowsOut).status, 0, 'a runner output saved with CRLF and a BOM still matches');

/* ------------------------------ any difference in the text is caught ------------------------------ */
var differs = function (text, part, why) {
  var r = run(text, part);
  assert.strictEqual(r.status, 1, why + ': refused');
  assert.ok(/^open-loops: Post DIFFERS — the (brief|details) read back is not the runner output's \1 \(first difference at character \d+: read back ".*", expected ".*"\)\. Repost it from the runner output, unchanged, and say so in the notes\.$/.test(r.err), why + ': says what differs: ' + r.err);
  return r.err;
};
var b = parts[0], dt = parts[1];
differs(asSent(b.replace('for 2026-10-05', 'for 2026-10-04')), 'brief', 'a changed date in the header');
differs(asSent(b.split(NL).slice(1).join(NL)), 'brief', 'a dropped header line');
differs(asSent(b.slice(0, -20)), 'brief', 'a truncated brief');
differs(asSent(b + NL + 'a reply typed under it'), 'brief', 'text added inside the block');
differs(asSent(dt.replace('venue', 'vanue')), 'details', 'one letter changed in the details');
var stripped = run(asSent(dt.split(ZW).join('')), 'details');
assert.ok(stripped.status === 1 && /^open-loops: Post BROKEN — /.test(stripped.err), 'the protective zero-width spaces stripped makes a live fence again: caught as BROKEN, before the text is compared: ' + stripped.err);
// Where the spaces are the only difference and no fence results (a space inside a word), the comparison itself catches it.
differs(asSent(dt.replace('Friday', 'Fri' + ZW + 'day')), 'details', 'an invisible character added to a word');
differs(asSent(b), 'details', 'the brief checked as the details');
differs(asSent(dt), 'brief', 'the details checked as the brief');
var msg = differs(asSent(dt.replace('venue', 'vanue')), 'details', 'the report names the place');
assert.ok(/vanue/.test(msg) && /venue/.test(msg), 'with the read-back and the expected text side by side: ' + msg);

/* ------------------------------ the one-code-block check still comes first ------------------------------ */
var broken = run(asSent(b + NL + FENCE + NL + 'more'), 'brief');
assert.ok(broken.status === 1 && /^open-loops: Post BROKEN — /.test(broken.err), 'a fence inside the message is BROKEN, not merely different: ' + broken.err);
assert.ok(/^open-loops: Post BROKEN — /.test(run(b, 'brief').err), 'a message with no fences at all is BROKEN');
assert.strictEqual(run(asSent(b)).out, 'Post OK.', 'and --check-post alone still only checks the block');

/* ------------------------------ misuse is an error, not a pass ------------------------------ */
var misuse = function (args, re, why) {
  var f = path.join(d, 'mis.txt'); fs.writeFileSync(f, asSent(b));
  var r = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'slack-run.js'), '--check-post', f].concat(args), { encoding: 'utf8' });
  assert.strictEqual(r.status, 1, why + ': exit 1');
  assert.ok(re.test(r.stderr), why + ': ' + r.stderr);
};
misuse(['--expect', outFile], /--expect <runner output file> and --part brief\|details go together/, '--expect without --part');
misuse(['--part', 'brief'], /go together/, '--part without --expect');
misuse(['--expect', outFile, '--part', 'both'], /--part is brief or details, got "both"/, 'an unknown part');
misuse(['--expect', path.join(d, 'nope.txt'), '--part', 'brief'], /--expect .*nope\.txt does not exist/, 'a missing runner output');
var noSplit = path.join(d, 'nosplit.txt'); fs.writeFileSync(noSplit, b);
misuse(['--expect', noSplit, '--part', 'brief'], /has 1 part\(s\), not a brief and its details/, 'a runner output with no separator line');

fs.rmSync(d, { recursive: true, force: true });
console.log('check-post against the runner output: OK');
