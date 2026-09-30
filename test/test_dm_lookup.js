/* Finding the last real digest when failure notices fill the latest messages, and saying so when it cannot be found.
 *
 * The bug: the lookup read the newest five DM messages. Each failed day adds a NOT RUN notice, so after a few of them the
 * last real digest is out of that window and the corrections typed under it are silently not read. The procedure now
 * pages the DM newest first through tools/dm-lookup.js; these tests run that procedure against a simulated paged
 * connector, and feed the runner only what the procedure returned, never the older digest directly.
 * Dates are fixed: the digest is 2026-09-30, six failed days follow, the run is 2026-10-07.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var S = require('../src/status.js');
var L = require('../src/ledger.js');
var lookup = require('../tools/dm-lookup.js');
var { main } = require('../slack-run.js');

var ME = 'alex@example.com', NL = String.fromCharCode(10);
var tmp = function () { return fs.mkdtempSync(path.join(os.tmpdir(), 'ol-lookup-')); };
var at = function (mo, day, h) { return (Date.UTC(2026, mo - 1, day, h) / 1000).toFixed(6); };
var banner = function (m) { return '=== Message from Alex Rivera <' + ME + '> (U0EXAMPLE001) at ' + m.ts + ' UTC ===' + NL + 'Message TS: ' + m.ts + NL + m.body; };

var dir = tmp(), cfgPath = path.join(dir, 'openloops.config.json'), ledger = path.join(dir, 'ledger.json');
fs.writeFileSync(cfgPath, JSON.stringify({ you: ME, selfDm: 'U0EXAMPLE001', tzOffset: 0, spotCheck: 0, ledger: ledger, channels: { include: ['#vector-freight'] } }));
var lena = '=== Message from Lena Borg <lena@vectorfreight.example> (U0EXAMPLE002) at ' + at(9, 28, 14) + ' UTC ===' + NL + 'Message TS: ' + at(9, 28, 14) + NL +
  "We'll get the revised contract back to you Thursday Oct 1.";
var conv = { channel: '#vector-freight', members: [], text: lena, complete: true };
var runInput = function (today, extra) {
  var p = path.join(dir, 'in-' + today + '-' + Object.keys(extra || {}).join('_') + '.json');
  fs.writeFileSync(p, JSON.stringify(Object.assign({ today: today, conversations: [conv], dm: { channel: 'D0', text: '' } }, extra || {})));
  return p;
};

// The real digest, posted on the 30th.
var d1 = main([runInput('2026-09-30'), '--config', cfgPath]);
var ref = (d1.split(NL)[0].match(/· ref ([0-9a-f]{4})/) || [])[1];
assert.ok(ref, 'the digest has a reference: ' + d1.split(NL)[0]);
var T0 = at(9, 30, 22);
var digestMsg = { ts: T0, body: '```' + NL + d1 + NL + '```' };
var notice = function (n) {
  return { ts: at(10, n, 22), body: S.notice({ outcome: 'not_delivered', cause: 'fetch', date: '2026-10-0' + n }, { date: '2026-09-30', ref: ref }).text };
};
var history = [digestMsg].concat([1, 2, 3, 4, 5, 6].map(notice));   // oldest first: the digest, then six failed days

/* ------------------------------ the connector, and the procedure that reads it ------------------------------ */
var pageNo = 0;
var pageFile = function (chunk, more, info) {
  var o = { text: chunk.map(banner).join(NL) };
  if (info !== 'none') o.pagination_info = more ? 'There are more messages. next_cursor: "c' + (pageNo + 1) + '"' : 'There are no more messages';
  var f = path.join(dir, 'page-' + (pageNo++) + '.json');
  fs.writeFileSync(f, JSON.stringify(o));
  return f;
};
/* Newest first, five a page — what slack_read_channel returns — handed to the tool one page at a time, exactly as SKILL.md says. */
var procedure = function (hist, today, info) {
  var newest = hist.slice().reverse(), n = 1, pages = 0;
  for (var i = 0; i < newest.length; i += 5, n++) {
    var out = lookup.main(['--page', pageFile(newest.slice(i, i + 5).reverse(), i + 5 < newest.length, info), '--number', String(n), '--today', today, '--config', cfgPath]);
    pages++;
    if (!/^NEXT/.test(out)) return { out: out, pages: pages };
  }
  throw new Error('the procedure ran off the end of the history without an answer');
};

// The bug, as it was: the newest five hold only notices, so a read of five finds no digest at all.
var firstPage = lookup.main(['--page', pageFile(history.slice(-5), true), '--number', '1', '--today', '2026-10-07', '--config', cfgPath]);
assert.ok(/^NEXT/.test(firstPage), 'the latest five are all notices, so a five-message lookup stops with no digest: ' + firstPage);

// The fix: the procedure reads on and finds it.
var found = procedure(history, '2026-10-07');
assert.strictEqual(found.pages, 2, 'it read a second page');
assert.ok(found.out.indexOf('FOUND ts=' + T0 + ' date=2026-09-30 ref=' + ref) === 0, found.out);
assert.ok(/dmLookup: found$/.test(found.out));
var foundTs = found.out.match(/ts=(\S+)/)[1];

// Codex follows the same lookup with structured Slack records, without inventing Claude banners.
var structuredLookup = function (chunk, more, n) {
  var f = path.join(dir, 'structured-' + n + '.json');
  fs.writeFileSync(f, JSON.stringify({ messages: chunk.map(function (m) {
    return { ts: m.ts, user: 'U0EXAMPLE001', text: m.body };
  }), pagination_info: more ? 'There are more messages. next_cursor: "next"' : 'There are no more messages' }));
  return lookup.main(['--page', f, '--number', String(n), '--today', '2026-10-07', '--config', cfgPath]);
};
assert.ok(/^NEXT/.test(structuredLookup(history.slice(-5), true, 1)));
assert.strictEqual(structuredLookup(history.slice(0, 2), false, 2), found.out,
  'structured pages find the same digest past the six notices');

/* ------------------------------ and the corrections under that digest are read ------------------------------ */
// What the procedure says to fetch next, built only from what it returned: the thread under that digest, and the DM since it.
var thread = [{ ts: foundTs, body: digestMsg.body }, { ts: at(10, 1, 9), body: '1' }].map(banner).join(NL);
var since = history.filter(function (m) { return parseFloat(m.ts) > parseFloat(foundTs); }).map(banner).join(NL);
var withCorrection = main([runInput('2026-10-07', { dm: { channel: 'D0', text: since }, dmThread: [{ root: foundTs, text: thread }], dmLookup: 'found' }), '--config', cfgPath]);
var rows = JSON.parse(fs.readFileSync(ledger, 'utf8')).rows;
assert.ok(rows.some(function (r) { return r[L.COL.verdict]; }), 'the correction typed under the digest was applied');
assert.ok(!/CORRECTIONS NOT CHECKED/.test(withCorrection), 'and nothing says the search gave out');

/* ------------------------------ when the digest cannot be found, it says so ------------------------------ */
var WARN = 'CORRECTIONS NOT CHECKED — the earlier digest could not be located within the available DM history. Earlier corrections may not have been reapplied.';
var runWith = function (lookupState, extra) {
  var d = tmp(), c = path.join(d, 'c.json'), p = path.join(d, 'i.json');
  fs.writeFileSync(c, JSON.stringify({ you: ME, selfDm: 'U0EXAMPLE001', tzOffset: 0, spotCheck: 0, ledger: path.join(d, 'l.json'), channels: { include: ['#vector-freight'] } }));
  var input = Object.assign({ today: '2026-10-07', conversations: [conv], dm: { channel: 'D0', text: '' } }, extra || {});
  if (lookupState !== undefined) input.dmLookup = lookupState;
  fs.writeFileSync(p, JSON.stringify(input));
  return main([p, '--config', c, '--dry']);
};
// Capped: only notices, more than ten pages of them.
var many = [];
for (var i = 0; i < 60; i++) many.push({ ts: (Date.UTC(2026, 9, 1, 0, i) / 1000).toFixed(6), body: notice(1).body });
var capped = procedure(many, '2026-10-07');
assert.strictEqual(capped.pages, 10, 'it stops at the page cap');
assert.ok(/^CAPPED/.test(capped.out) && /dmLookup: capped$/.test(capped.out), capped.out);
var cappedDigest = runWith('capped');
assert.ok(cappedDigest.indexOf(WARN) > -1, 'the digest says the corrections were not checked, in the approved words');
assert.ok(/\n1 read warning — in the thread\./.test(cappedDigest), 'and the brief counts it: ' + cappedDigest.split('\n-- thread --')[0]);
// The connector gives no pagination evidence: said as a limitation, not taken for a first run.
var unknown = procedure(many.slice(0, 7), '2026-10-07', 'none');
assert.ok(/^UNKNOWN/.test(unknown.out) && /dmLookup: cannot_page$/.test(unknown.out), unknown.out);
var unpaged = runWith('cannot_page');
assert.ok(unpaged.indexOf('CORRECTIONS NOT CHECKED — the earlier digest could not be located within the available DM history (this connector cannot page it). Earlier corrections may not have been reapplied.') > -1, unpaged);
// A read that failed.
var failedOut = lookup.main(['--failed']);
assert.ok(/dmLookup: failed$/.test(failedOut));
assert.ok(runWith('failed').indexOf(WARN) > -1);
// Anything unrecognised is a search that did not finish, never a quiet pass.
assert.ok(runWith('banana').indexOf(WARN) > -1);
// The whole history read, no earlier digest: a first run, and nothing is wrong.
var none = procedure(many.slice(0, 3), '2026-10-07');
assert.ok(/^NONE/.test(none.out) && /dmLookup: searched_none$/.test(none.out), none.out);
assert.ok(runWith('searched_none').indexOf('CORRECTIONS NOT CHECKED') < 0, 'a fully searched history with no digest is not a warning');
assert.ok(runWith('found').indexOf('CORRECTIONS NOT CHECKED') < 0);
assert.ok(runWith(undefined).indexOf('CORRECTIONS NOT CHECKED') < 0, 'an input from before the field existed claims nothing');
// A digest dated today is this run's own: never the one to start from.
var todays = lookup.main(['--page', pageFile([{ ts: at(10, 7, 10), body: '```' + NL + d1.replace('for 2026-09-30', 'for 2026-10-07') + NL + '```' }], false), '--number', '1', '--today', '2026-10-07', '--config', cfgPath]);
assert.ok(/^NONE/.test(todays), 'a digest dated today is not an earlier one: ' + todays);
assert.throws(function () { lookup.main(['--page', 'x', '--number', '0', '--today', '2026-10-07']); }, /usage/);

/* ------------------------------ the instructions ------------------------------ */
var skill = fs.readFileSync(path.join(__dirname, '..', 'skills', 'open-loops', 'SKILL.md'), 'utf8').split(String.fromCharCode(13)).join('');
assert.ok(skill.indexOf('tools/dm-lookup.js') > -1 && skill.indexOf('"dmLookup"') > -1, 'SKILL.md pages the lookup and passes dmLookup');
assert.ok(!/limit=15/.test(skill) && !/five messages, or fifteen/.test(skill), 'and no longer relies on a fixed window');
assert.ok(/never treated as a first run/.test(skill), 'and says an unfinished search is not a first run');
assert.ok(/\*\*Then read the replacement back\*\*/.test(skill) && /do not post a third time/.test(skill), 'a repost is read back, and not retried');
assert.ok(/`--verified yes` only if the brief — after a repost, the replacement; the original malformed post no longer counts — read back/.test(skill), 'and --verified refers to the replacement');

console.log('dm-lookup: OK');
