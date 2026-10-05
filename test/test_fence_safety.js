/* A quoted sentence cannot break the digest's code block (adversarial review 2026-10-05, Codex finding 9).
 *
 * Each posted part is wrapped in one code fence. A commitment that quotes three backticks ("I will send ``` contract tomorrow") put a second fence inside the part, which ends the
 * block early so the rest of the message renders as plain text, and the read-back (opening fence, first line) could not see it. The digest now writes any run of three or more
 * backticks with a zero-width space between them, and `slack-run.js --check-post` checks the whole posted message. Only the rendering changes: the ledger keeps the sentence as it
 * was said. Verified locally; nothing here posts anywhere.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');
var { main, checkPost } = require('../slack-run.js');
var { fenceSafe } = require('../src/digest.js');
var { fileStore } = require('../src/store.js');
var L = require('../src/ledger.js');

var NL = String.fromCharCode(10), ZW = String.fromCharCode(0x200b), FENCE = '```', ME = 'alex@example.com';
var count = function (s) { return s.split(FENCE).length - 1; };

/* ------------------------------ fenceSafe ------------------------------ */
assert.strictEqual(count(fenceSafe('a ``` b')), 0, 'a run of three no longer closes a fence');
assert.strictEqual(fenceSafe('a ``` b').split(ZW).join(''), 'a ``` b', 'and reads the same without the invisible character');
assert.strictEqual(count(fenceSafe('``````')), 0, 'six');
assert.strictEqual(count(fenceSafe('`````')), 0, 'five');
assert.strictEqual(fenceSafe('use `code` and ``double`` here'), 'use `code` and ``double`` here', 'one or two backticks are left alone');
assert.strictEqual(fenceSafe('nothing special'), 'nothing special');

/* ------------------------------ the digest ------------------------------ */
var d = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-fence-'));
var cfg = path.join(d, 'c.json'), ledger = path.join(d, 'l.json');
fs.writeFileSync(cfg, JSON.stringify({ you: ME, selfUid: 'U0EXAMPLE001', tzOffset: 0, lookbackDays: 30, spotCheck: 0, ledger: ledger }));
var SENTENCE = 'I will send ``` contract tomorrow.';
var input = path.join(d, 'in.json');
fs.writeFileSync(input, JSON.stringify({ today: '2026-10-05', conversations: [{ channel: '#ops', complete: true, messages: [
  { ts: '1790870400.000001', user: 'U0EXAMPLE001', text: SENTENCE },
  { ts: '1790870500.000001', user: 'U0EXAMPLE001', text: 'I will send the report ````` by Friday, ``` and ```` the deck too.' },
  { ts: '1790870600.000001', user: 'U0EXAMPLE002', text: 'Can you review the plan ``` before Thursday?' }] }], dm: { messages: [] }, dmLookup: 'searched_none' }));
var out = main([input, '--config', cfg]);
var parts = out.split(/^-- thread --$/m);
assert.strictEqual(parts.length, 2);
parts.forEach(function (p, k) {
  assert.strictEqual(count(p), 0, 'part ' + (k + 1) + ' holds no fence of its own');
  assert.strictEqual(count(FENCE + NL + p.trim() + NL + FENCE), 2, 'so wrapped as the procedure wraps it, part ' + (k + 1) + ' is exactly one block');
});
assert.ok(out.indexOf(ZW) > -1, 'the backticks were written with the invisible separator');
assert.ok(out.split(ZW).join('').indexOf(SENTENCE) > -1, 'and the quoted sentence reads as it was said: ' + out.split(NL).slice(0, 6).join(NL));

// Only the rendering changes. The ledger keeps the sentence exactly.
var stored = fileStore(ledger).readLedger().map(function (r) { return L.cell(r[L.COL.what]); }).filter(Boolean);
assert.ok(stored.indexOf(SENTENCE) > -1, 'the ledger holds the sentence as it was said: ' + JSON.stringify(stored));
assert.ok(stored.every(function (s) { return s.indexOf(ZW) === -1; }), 'with no invisible character in it');
// A digest with no backticks is untouched.
fs.writeFileSync(input, JSON.stringify({ today: '2026-10-06', conversations: [{ channel: '#ops', complete: true, messages: [{ ts: '1790960400.000001', user: 'U0EXAMPLE001', text: 'I will send the contract tomorrow.' }] }], dm: { messages: [] }, dmLookup: 'searched_none' }));
var cfg2 = path.join(d, 'c2.json');
fs.writeFileSync(cfg2, JSON.stringify({ you: ME, selfUid: 'U0EXAMPLE001', tzOffset: 0, lookbackDays: 30, spotCheck: 0, ledger: path.join(d, 'l2.json') }));
assert.strictEqual(main([input, '--config', cfg2, '--dry']).indexOf(ZW), -1, 'nothing is inserted when there is nothing to protect');

/* ------------------------------ checking the whole posted message ------------------------------ */
var f = path.join(d, 'post.txt');
var check = function (text) { fs.writeFileSync(f, text); return cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'slack-run.js'), '--check-post', f], { encoding: 'utf8' }); };
var fenced = function (body) { return FENCE + NL + body + NL + FENCE; };
var ok = check(fenced('OPEN LOOPS — for 2026-10-05' + NL + '3 open'));
assert.deepStrictEqual([ok.status, ok.stdout.trim()], [0, 'Post OK.'], 'one block is fine');
assert.strictEqual(check(fenced(parts[0].trim())).status, 0, 'and so is the digest\'s own brief, with the backticks in it');
assert.strictEqual(check(fenced(parts[1].trim())).status, 0, 'and its details');
var broken = check(fenced('OPEN LOOPS' + NL + SENTENCE));
assert.strictEqual(broken.status, 1, 'a fence inside the message is caught');
assert.ok(/Post BROKEN — the message must be one code block: opening and closing fence and no other \(found 3\)\./.test(broken.stderr), broken.stderr);
assert.strictEqual(check(FENCE + NL + 'OPEN LOOPS').status, 1, 'a missing closing fence is caught');
assert.strictEqual(check('OPEN LOOPS' + NL + FENCE).status, 1, 'a missing opening fence is caught');
assert.strictEqual(check('OPEN LOOPS').status, 1, 'no fence at all is caught');
assert.strictEqual(check(fenced('a') + NL + 'trailing words').status, 1, 'text outside the block is caught');
assert.strictEqual(cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'slack-run.js'), '--check-post'], { encoding: 'utf8' }).status, 1, 'no file named is an error');
assert.throws(function () { checkPost(path.join(d, 'missing.txt')); }, /does not exist/);

fs.rmSync(d, { recursive: true, force: true });
console.log('fence safety: OK');
