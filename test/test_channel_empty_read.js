/* A channel read with nothing in it is not "could not be parsed" (found on the first real digest after the adversarial fixes, 2026-10-06).
 *
 * #all-open-loops held only messages older than the 21-day window, so its read came back as the connector's header and nothing else:
 * "Channel: #all-open-loops (C0…)", a blank line, and the pagination note "There are no more messages available.". That is a complete, empty read.
 * emptyResponse() only accepted a blank response, so the digest printed "NOTHING READ IN #all-open-loops" and "INCOMPLETE — … could not be parsed", and the
 * saved read state was "incomplete". The self-DM had the same shape and was fixed on its own (85b446c); the channel path never was.
 *
 * Only the connector's own header counts, and the pagination note still decides whether the read was complete: a header with no id or extra words, text
 * that is not a message, a read with more pages to come, and a read with no pagination evidence at all are all still reported. Nothing is edited.
 */
var assert = require('assert');
var crypto = require('crypto');
var fs = require('fs');
var os = require('os');
var path = require('path');
var { main } = require('../slack-run.js');
var { emptyResponse, withoutHeader, coverage } = require('../src/slack-coverage.js');

var NL = String.fromCharCode(10), ME = 'alex@example.com';
var HEADER = 'Channel: #all-open-loops (C0BV0PRC95E)' + NL + NL;
var DONE = 'There are no more messages available.' + NL;

/* ------------------------------ emptyResponse, directly ------------------------------ */
var page = function (text, info) { var p = { text: text }; if (info !== undefined) p.pagination_info = info; return p; };
var empty = function (src) { return emptyResponse(src); };
assert.strictEqual(empty({ text: '' }), true, 'a blank response, as before');
assert.strictEqual(empty({ text: '  ' + NL }), true, 'whitespace, as before');
assert.strictEqual(empty({ text: HEADER }), true, 'the observed shape: a header and a blank line');
assert.strictEqual(empty({ text: HEADER.trim() }), true, 'no trailing newlines');
assert.strictEqual(empty({ text: 'Channel: DM (D0BU6BTACM8)' + NL + NL }), true, 'the self-DM header');
assert.strictEqual(empty({ pages: [page(HEADER, DONE), page(HEADER, DONE)] }), true, 'pages that are each a header');
assert.strictEqual(empty({ messages: [] }), true, 'an empty message list, as before');
assert.strictEqual(withoutHeader(HEADER).trim(), '', 'withoutHeader removes the header line only');
assert.strictEqual(withoutHeader('Channel: #x (C0ABCDE)' + NL + 'hello'), NL + 'hello', 'and leaves what is not the header');
// What is NOT the connector's header is not empty.
['Channel: #x',                                     // no id
 'Channel: #x (C0)',                                // an id too short to be one
 'Channel: #x (c0abcde)',                           // lower case
 'Channel: #x (C0ABCDE) and more',                  // extra words after it
 'Channel #x (C0ABCDE)',                            // no colon
 'channel: #x (C0ABCDE)',                           // not the connector's capitalisation
 'Channel: #x (C0ABCDE)' + NL + 'some text with no message structure',
 'Channel: #x (C0ABCDE)' + NL + 'Message TS: 1790870400.000001',
 '=== Message from Pat <p@e.com> (U0ABCDE) at now ===' + NL + 'no timestamp line'
].forEach(function (t) { assert.strictEqual(empty({ text: t }), false, 'not empty: ' + JSON.stringify(t)); });
assert.strictEqual(empty({ pages: [page(HEADER, DONE), page(HEADER + 'stray text', DONE)] }), false, 'one page with anything else spoils it');
assert.strictEqual(empty({ pages: [] }), false, 'no pages is not an empty read');

/* ------------------------------ through the digest ------------------------------ */
var d = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-chempty-'));
var n = 0;
var cfg = path.join(d, 'openloops.config.json');
fs.writeFileSync(cfg, JSON.stringify({ you: ME, selfUid: 'U0EXAMPLE001', tzOffset: 0, lookbackDays: 21, spotCheck: 0, ledger: 'ledger.json' }));
var real = { channel: '#ops', members: [], complete: true, messages: [{ ts: '1790870400.000001', user: 'U0EXAMPLE001', text: "I'll send the signed contract Friday." }] };
var runWith = function (extra, real_run) {
  var input = path.join(d, 'in' + (n++) + '.json');
  fs.writeFileSync(input, JSON.stringify({ today: '2026-10-05', conversations: [real].concat(extra ? [extra] : []), dm: { messages: [] }, dmLookup: 'searched_none' }));
  var before = crypto.createHash('sha1').update(fs.readFileSync(input)).digest('hex');
  var out = main([input, '--config', cfg].concat(real_run ? [] : ['--dry']));
  assert.strictEqual(crypto.createHash('sha1').update(fs.readFileSync(input)).digest('hex'), before, 'the input is never edited');
  return out;
};
var readState = function () { return JSON.parse(fs.readFileSync(path.join(d, 'status.staged.json'), 'utf8')).read; };
var FLAGGED = /NOTHING READ IN #all-open-loops|could not be parsed|read warning|INCOMPLETE/;
// oldest is the request's lower bound: it must reach back to the window start (21 days before 2026-10-05), as the run's real request did.
var chan = function (pages) { return { channel: '#all-open-loops', members: [], oldest: '1789300000', pages: pages }; };

// 1. The real case: header only, pagination exhausted. No warning, and the saved read state is complete.
var out = runWith(chan([page(HEADER, DONE)]), true);
assert.ok(!FLAGGED.test(out), 'a legitimate empty read raises no warning:\n' + out.split(NL).slice(0, 6).join(NL));
assert.ok(/signed contract/.test(out), 'and the other channel is read as ever');
assert.deepStrictEqual(readState(), Object.assign({}, readState(), { state: 'complete', why: [] }), 'the saved read state is complete, with nothing to explain');
// Marked complete instead of paginated, the same.
assert.ok(!FLAGGED.test(runWith({ channel: '#all-open-loops', members: [], complete: true, text: HEADER })), 'complete:true on a header-only text');

// 2. Pagination still decides. A header with more pages to come, or with no evidence that it is the last page, is not a finished read.
var more = runWith(chan([page(HEADER, 'There are more messages available. To view the next page, use cursor: `abc`' + NL)]));
assert.ok(/NOTHING READ IN #all-open-loops|INCOMPLETE/.test(more), 'a header-only first page with more to come is still flagged:\n' + more.split(NL).slice(0, 6).join(NL));
var noInfo = runWith(chan([page(HEADER)]));
assert.ok(/NOTHING READ IN #all-open-loops|INCOMPLETE/.test(noInfo), 'a header-only read with no pagination evidence is still flagged');
var unrecognised = runWith(chan([page(HEADER, 'something the connector never said')]));
assert.ok(/NOTHING READ IN #all-open-loops|INCOMPLETE/.test(unrecognised), 'so is one whose pagination note is not recognised');
assert.strictEqual(coverage(chan([page(HEADER, DONE)]), '2026-09-14', 0).state, 'complete', 'while the same header with the connector\'s "no more messages" is complete');

// 3. Text that is not the connector's empty result is still unparseable, however it starts.
[ 'Channel: #all-open-loops (C0BV0PRC95E)' + NL + NL + 'something the connector never sends',
  'Channel: #all-open-loops' + NL + NL,
  'Channel: #all-open-loops (C0BV0PRC95E) with extra words' + NL + NL,
  'Message TS: 1790870400.000001' + NL + 'a message that lost its banner',
  'not a Slack response at all'
].forEach(function (text) {
  var r = runWith(chan([page(text, DONE)]));
  assert.ok(/could not be parsed/.test(r), 'still reported as unparseable: ' + JSON.stringify(text) + NL + r.split(NL).slice(0, 8).join(NL));
});
// A real message beside the header is read, not treated as empty.
var withMsg = runWith(chan([page(HEADER + '=== Message from Pat Lee <pat@example.com> (U0EXAMPLE002) at now ===' + NL + 'Message TS: 1790870700.000001' + NL + "I'll send the budget Monday.", DONE)]));
assert.ok(/budget Monday/.test(withMsg) && !FLAGGED.test(withMsg), 'a header followed by a real message is a normal read');

fs.rmSync(d, { recursive: true, force: true });
console.log('channel empty read: OK');
