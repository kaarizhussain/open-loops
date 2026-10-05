/* A thread root with nothing detectable in it does not hide its replies (adversarial review 2026-10-05, Codex finding 2 and the parsing pass's
 * A1/A3/A6). A mention-only root, a bot post with no text, or a root whose file was deleted was dropped whole, so the run never learned the thread
 * had replies: beside one ordinary greeting the digest said "Nothing outstanding. Genuinely" and listed no unread thread. A thread read that held
 * only the root counted as reading the replies, and a root marked by thread_ts alone (no reply_count) was not a thread at all.
 *
 * The root is still not shown as a commitment. What changes is that its thread is owed a fetch, and the digest says so when it was not made.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var { main } = require('../slack-run.js');

var NL = String.fromCharCode(10), ME = 'alex@example.com';
var d = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-hidden-'));
var cfg = path.join(d, 'c.json');
fs.writeFileSync(cfg, JSON.stringify({ you: ME, selfUid: 'U0EXAMPLE001', tzOffset: 0, lookbackDays: 30, spotCheck: 0, ledger: path.join(d, 'l.json') }));
var n = 0;
var run = function (conversations, threads) {
  var p = path.join(d, 'in' + (n++) + '.json');
  fs.writeFileSync(p, JSON.stringify({ today: '2026-10-05', conversations: conversations, threads: threads || [], dm: { messages: [] }, dmLookup: 'searched_none' }));
  return main([p, '--config', cfg, '--dry']);
};
var UNREAD = 'INCOMPLETE — 1 thread had replies that were not read. Anything promised inside them is missing from this list.';
var T1 = '1790870400.000001', T2 = '1790870500.000001', T3 = '1790870600.000001';
var greeting = { ts: T1, user: 'U0EXAMPLE002', text: 'Hi team' };
var chan = function (messages) { return [{ channel: '#ops', messages: messages, complete: true }]; };
var silent = function (out, why) {
  assert.ok(out.indexOf(UNREAD) === -1 && out.indexOf('Nothing outstanding. Genuinely') > -1, why + ': nothing is claimed unread when there is nothing to read');
};
var warned = function (out, why) {
  assert.ok(out.indexOf(UNREAD) > -1, why + ': the unread thread is reported\n' + out.split(NL).slice(0, 6).join(NL));
  assert.ok(out.indexOf('Nothing outstanding. Genuinely') === -1, why + ': and the list is not called clear');
};

/* ------------------------------ roots with nothing in them ------------------------------ */
warned(run(chan([greeting, { ts: T2, user: 'U0EXAMPLE003', text: '<@U0EXAMPLE001>', thread_ts: T2, reply_count: 1 }])), 'a mention-only root (the review finding)');
warned(run(chan([greeting, { ts: T2, bot_id: 'B0EXAMPLE01', subtype: 'bot_message', text: '', thread_ts: T2, reply_count: 2 }])), 'a bot root with no text');
warned(run(chan([greeting, { ts: T2, user: 'U0EXAMPLE003', text: '', files: [{ id: 'F1', mode: 'tombstone' }], thread_ts: T2, reply_count: 1 }])), 'a root whose only file was deleted');
warned(run(chan([greeting, { ts: T2, user: 'U0EXAMPLE003', text: 'Can you send the deck by Friday?', thread_ts: T2 }])), 'a root marked only by thread_ts');
// The text adapter the same way: a mention-only root carrying the connector's thread note.
var banner = function (uid, ts, body) { return '=== Message from Pat Lee <pat@example.com> (' + uid + ') at ' + ts + ' UTC ===' + NL + 'Message TS: ' + ts + NL + body; };
warned(run([{ channel: '#ops', complete: true, text: banner('U0EXAMPLE002', T1, 'Hi team') + NL + banner('U0EXAMPLE003', T2, '<@U0EXAMPLE001>' + NL + 'Thread: 1 replies (latest: 2026-10-05 10:00:00 EDT)') }]), 'a mention-only root in a text read');
// An empty message with no replies is nothing, and says nothing.
silent(run(chan([greeting, { ts: T2, user: 'U0EXAMPLE003', text: '<@U0EXAMPLE001>' }])), 'a mention-only message with no thread');
silent(run(chan([greeting, { ts: T2, user: 'U0EXAMPLE003', text: '', thread_ts: T2, reply_count: 0 }])), 'an empty root with a zero count');

/* ------------------------------ fetching the thread settles it ------------------------------ */
var root = { ts: T2, user: 'U0EXAMPLE003', text: '<@U0EXAMPLE001>', thread_ts: T2, reply_count: 1 };
var reply = { ts: T3, user: 'U0EXAMPLE001', text: "I'll send the signed contract Friday.", thread_ts: T2 };
var out = run(chan([greeting, root]), [{ channel: '#ops', root: T2, messages: [root, reply], complete: true }]);
assert.ok(out.indexOf(UNREAD) === -1, 'a fetched thread is not reported unread');
assert.ok(/signed contract Friday/.test(out), 'and the commitment inside it reaches the digest: ' + out.split(NL).slice(0, 8).join(NL));
assert.ok(!/<@U0EXAMPLE001>/.test(out.split('Why each of these is here')[0] || ''), 'while the root itself is not listed as one');

/* ------------------------------ a thread read must hold the replies, not only the root ------------------------------ */
var root3 = { ts: T2, user: 'U0EXAMPLE003', text: 'Can you send the deck by Friday?', thread_ts: T2, reply_count: 3 };
var rep = function (ts, text) { return { ts: ts, user: 'U0EXAMPLE001', text: text, thread_ts: T2 }; };
var thread = function (messages) { return [{ channel: '#ops', root: T2, messages: messages, complete: true }]; };
warned(run(chan([greeting, root3]), thread([root3])), 'a thread read holding only the root (reply_count 3)');
warned(run(chan([greeting, root3]), thread([root3, rep('1790870601.000001', 'Looking.'), rep('1790870602.000001', 'Still looking.')])), 'a thread read holding 2 of 3 replies');
out = run(chan([greeting, root3]), thread([root3, rep('1790870601.000001', 'Looking.'), rep('1790870602.000001', 'Found it.'), rep('1790870603.000001', 'Sending now.')]));
assert.ok(out.indexOf(UNREAD) === -1, 'a thread read holding all 3 replies is not reported');
// A reply with nothing detectable in it still counts as read: the thread was fully fetched.
var root1 = { ts: T2, user: 'U0EXAMPLE003', text: 'Can you send the deck by Friday?', thread_ts: T2, reply_count: 1 };
out = run(chan([greeting, root1]), thread([root1, rep('1790870601.000001', '<@U0EXAMPLE003>')]));
assert.ok(out.indexOf(UNREAD) === -1, 'a thread whose only reply is a mention was read in full: ' + out.split(NL).slice(0, 5).join(NL));

fs.rmSync(d, { recursive: true, force: true });
console.log('hidden threads: OK');
