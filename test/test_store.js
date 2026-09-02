/* The file-backed ledger. Same six operations the Apps Script one provides, so the
 * runner never has to know which it is talking to. */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

global.loopKey = require('../src/loops.js').loopKey;
var L = require('../src/ledger.js');
var { fileStore } = require('../src/store.js');
var COL = L.COL;

var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openloops-'));
var file = path.join(dir, 'nested', 'ledger.json');

/* --- a first run has nothing, and must not treat that as an error --- */
var s = fileStore(file);
assert.deepStrictEqual(s.readLedger(), [], 'a missing ledger is an empty one');
assert.deepStrictEqual(s.recallDigest('2026-08-06'), []);
assert.deepStrictEqual(s.seenReplies(), []);

/* --- rows survive a round trip, including the directory not existing yet --- */
var rows = [
  ['k-a', '2026-08-01', '2026-08-06', '', 'owed_by_us', 'a@b.com', 'alpha', ''],
  ['k-b', '2026-08-01', '2026-08-06', '', 'owed_to_us', 'b@b.com', 'beta', 'x']
];
s.writeLedger(rows);
assert.ok(fs.existsSync(file), 'the store creates the directory it was pointed at');

var reopened = fileStore(file);
assert.deepStrictEqual(reopened.readLedger(), rows, 'rows come back exactly as written');
assert.strictEqual(reopened.readLedger()[1][COL.verdict], 'x', 'and verdicts survive the trip');

/* --- pruning shortens the list, and the file must shorten with it --- */
var kept = reopened.readLedger();
kept.pop();
reopened.writeLedger(kept);
assert.strictEqual(fileStore(file).readLedger().length, 1,
  'a pruned row is gone from the file, not left below the new end');

/* --- the two memos --- */
reopened.rememberDigest('2026-08-06', ['k-a', 'k-b']);
assert.deepStrictEqual(fileStore(file).recallDigest('2026-08-06'), ['k-a', 'k-b'],
  'the digest order is what lets a reply be resolved later');
assert.deepStrictEqual(fileStore(file).recallDigest('1999-01-01'), [],
  'an unremembered digest resolves to nothing rather than throwing');

/* Only a week of digests is kept — a reply older than that has nothing to resolve
   against anyway, and the memo would otherwise grow forever. */
for (var d = 1; d <= 10; d++) {
  reopened.rememberDigest('2026-09-' + String(d).padStart(2, '0'), ['k' + d]);
}
var memo = JSON.parse(fs.readFileSync(file, 'utf8')).digests;
assert.strictEqual(Object.keys(memo).length, 7, 'seven days of digests, no more');
assert.ok(!memo['2026-08-06'], 'and the oldest fall off first');

reopened.rememberReplies(['r1', 'r2']);
assert.deepStrictEqual(fileStore(file).seenReplies(), ['r1', 'r2'],
  'replies already acted on are remembered, or one reply eats the list all week');

/* --- a corrupt ledger must not read as "nothing was ever marked wrong" --- */
fs.writeFileSync(file, '{ this is not json');
assert.throws(function () { fileStore(file); }, /could not be read/,
  'refuses to start rather than silently un-rejecting every marked item');

/* --- the shape is the spreadsheet's, so a ledger can move between runtimes --- */
var portable = fileStore(path.join(dir, 'portable.json'));
portable.writeLedger([['k', '', '', '', 'owed_by_us', '', '', '']]);
var raw = JSON.parse(fs.readFileSync(path.join(dir, 'portable.json'), 'utf8'));
assert.ok(Array.isArray(raw.rows[0]), 'rows stay arrays, matching the sheet layout');
assert.strictEqual(raw.rows[0].length, L.LEDGER_COLS.length);

fs.rmSync(dir, { recursive: true, force: true });
console.log('store: OK');
