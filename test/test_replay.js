/* Real Slack, replayed.
 *
 * Every other suite runs on text written by the same people who wrote the regexes, which
 * is how chat-shaped bugs kept surviving until somebody used the thing. These files are
 * what the connector actually returned on 2026-09-04 — two channel reads and a thread
 * read — with identifiers replaced by tools/sanitize-capture.js and nothing else changed.
 * They are the input that produced the first digest posted to a real DM.
 *
 * What they check is the one thing a fixture cannot: that the parser still reads the
 * format Slack really sends. The banner's trailing space, the "*Sent using*" footer on
 * every message, join notices, the thread read's separate From:/Time: shape.
 *
 * Every message here is the reader's own — it was a one-member workspace — so this says
 * nothing yet about messages from other people. The seed run's captures go beside these.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');
var loops = require('../src/loops.js');
global.OWNER = loops.OWNER;
global.LABEL = loops.LABEL;
global.loopKey = loops.loopKey;
var { parseChannel } = require('../src/slack.js');
var { main } = require('../slack-run.js');

var D = path.join(__dirname, 'replay', '2026-09-04');
var rd = function (f) { return fs.readFileSync(path.join(D, f), 'utf8'); };
var ROOT = '1788292991.482509';
var opts = function (channel, extra) {
  return Object.assign({ channel: channel, members: [], tzOffset: -240,
    self: 'you@example.com', selfUid: 'U0EXAMPLE001' }, extra || {});
};

var chan = parseChannel(rd('all-open-loops.txt'), opts('#all-open-loops'));
var chan2 = parseChannel(rd('new-channel.txt'), opts('#new-channel'));
var thread = parseChannel(rd('thread-halcyon.txt'), opts('#all-open-loops', { threadId: ROOT }));
var byId = {};
chan.concat(chan2).forEach(function (m) { byId[m.id] = m; });
thread.forEach(function (m) { byId[m.id] = m; });
var msgs = Object.keys(byId).map(function (k) { return byId[k]; })
  .sort(function (a, b) { return parseFloat(a.id) - parseFloat(b.id); });

/* --- the format Slack actually sends --- */
assert.strictEqual(chan.length, 12, 'thirteen banners, one of them a join notice');
assert.strictEqual(chan2.length, 4, 'five banners, one of them a join notice');
assert.strictEqual(thread.length, 2, 'the thread read: parent and one reply');
assert.strictEqual(msgs.length, 17, 'the parent is in both reads and counts once');
assert.ok(msgs.every(function (m) { return !/Sent using/i.test(m.body); }),
  'the app footer is stripped from every message');
assert.ok(msgs.every(function (m) { return !/has joined the channel/.test(m.body); }),
  'join notices are dropped');
assert.ok(msgs.some(function (m) { return m.body.indexOf('—') > -1; }),
  'an em-dash survives the read');
assert.deepStrictEqual(chan.filter(function (m) { return m.hasThread; }).map(function (m) { return m.id; }),
  [ROOT], 'the thread root is flagged from its "Thread: 1 replies" line');
var reply = msgs.filter(function (m) { return /scope doc/.test(m.body); })[0];
assert.ok(reply && reply.threadId === ROOT,
  'the reply, which only the thread read contains, is keyed on its root');

/* --- identity, on the real banner --- */
assert.ok(msgs.every(function (m) { return m.from === 'you@example.com'; }),
  'every message resolves to the reader');
var noEmail = rd('all-open-loops.txt').replace(/ <you@example\.com>/g, '');
assert.ok(parseChannel(noEmail, opts('#a')).every(function (m) { return m.from === 'you@example.com'; }),
  'with the email withheld, the reader is still found by their Slack id');
assert.ok(parseChannel(noEmail, { channel: '#a', members: [], tzOffset: -240 })
  .every(function (m) { return m.from === 'U0EXAMPLE001@slack.local'; }),
  'and without that id it falls back to one nobody configured — which is why the runner passes it');

/* --- what the detector makes of it --- */
var r = loops.detectLoops(msgs, [], { exec: 'you@example.com', today: '2026-09-04', principals: [] });
var byType = {};
r.open.forEach(function (l) { byType[l.type] = (byType[l.type] || 0) + 1; });
/* Two asks, not one. "Let me know your thoughts on the deck" was missed on the day because
   the whose-turn rule tracked one question per channel; each now stands alone. */
assert.deepStrictEqual(byType, { owed_by_us: 6, agreed_unscheduled: 2, awaiting_reply: 2 });
assert.deepStrictEqual(r.closed.map(function (l) { return l.what; }).sort(), [
  'Also — I\'ll book the offsite venue by end of week.',
  'I\'ll send the revised pricing sheet to Meridian by Thursday.'
], 'the two promises a later "Done." and "sent over" delivered');
var scope = r.open.filter(function (l) { return /scope doc/.test(l.what); })[0];
assert.strictEqual(scope.due, '2026-09-02', '"Wednesday", resolved against the reply inside the thread');

/* --- and through the runner, the way the evening run reads it --- */
var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openloops-replay-'));
fs.writeFileSync(path.join(tmp, 'in.json'), JSON.stringify({ today: '2026-09-04', tzOffset: -240,
  conversations: [{ channel: '#all-open-loops', members: [], text: rd('all-open-loops.txt') },
                  { channel: '#new-channel', members: [], text: rd('new-channel.txt') }],
  threads: [{ channel: '#all-open-loops', root: ROOT, members: [], text: rd('thread-halcyon.txt') }] }));
fs.writeFileSync(path.join(tmp, 'cfg.json'), JSON.stringify({ you: 'you@example.com',
  selfDm: 'U0EXAMPLE001', supporting: [], ledger: path.join(tmp, 'ledger.json') }));
var digest = main([path.join(tmp, 'in.json'), '--config', path.join(tmp, 'cfg.json'), '--dry']);
assert.ok(/Read 17 messages across 2 conversations/.test(digest), 'the runner reads what the parser reads');
assert.ok(/^10 open/m.test(digest));
assert.ok(/CHASE THEM \(2\)/.test(digest) && /YOURS TO HANDLE \(8\)/.test(digest) &&
  /CLOSED ITSELF \(2\)/.test(digest), 'and sorts it into the same piles the posted digest had');

/* --- the sanitizer that made these ---
 *
 * The next captures come from the seed run, with other people in them, so the tool has to
 * be trustworthy without anyone re-reading every file by eye. A one-word display name is
 * the hard case: it must be replaced where it is a name and left alone inside a word. */
var cap = [
  '=== Message from Sam <sam@vf.com> (U0SAMPLE123) at 2026-09-01 12:00:00 EDT === ',
  'Message TS: 1788271200.000100',
  'Sam, the same sample again — <@U0READER99|Pat Reader> will send it.',
  '',
  '=== Message from Pat Reader <pat@corp.io> (U0READER99) at 2026-09-01 12:05:00 EDT === ',
  'Message TS: 1788271500.000200',
  'Thanks Sam — cc sam@vf.com and SAM@VF.COM.',
  'Copying bob@corp.io and jo@gmail.com in.'
].join('\n');
fs.writeFileSync(path.join(tmp, 'cap.txt'), cap);
var san = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'sanitize-capture.js'),
  '--you', 'pat@corp.io', '--self', 'U0READER99', '--out', path.join(tmp, 'out'),
  path.join(tmp, 'cap.txt')], { encoding: 'utf8' });
assert.strictEqual(san.status, 0, 'the sanitizer ran: ' + san.stderr);
var clean = fs.readFileSync(path.join(tmp, 'out', 'cap.txt'), 'utf8');
assert.ok(!/U0READER99|U0SAMPLE123|pat@corp|sam@vf|bob@corp|jo@gmail|Pat Reader/i.test(clean),
  'no identifier survives');
assert.ok(/\(U0EXAMPLE001\)/.test(clean) && /<you@example\.com>/.test(clean) && /Alex Rivera/.test(clean),
  'the reader takes the placeholders every other fixture uses');
assert.strictEqual((clean.match(/person1@org1\.example/g) || []).length, 3,
  'one address, one placeholder, whatever its case');

/* Sides survive sanitizing. Everything used to become @example.com, the reader's own
   domain, which put every other participant on the reader's side. */
var sideOf = loops.side;
assert.ok(/person2@example\.com/.test(clean), 'a colleague at the reader\'s company stays on the reader\'s side');
assert.ok(/person3@org2\.example/.test(clean), 'a consumer address is a side of its own');
assert.notStrictEqual(sideOf('person1@org1.example'), sideOf('you@example.com'),
  'and an outsider is still an outsider');
assert.notStrictEqual(sideOf('person3@org2.example'), sideOf('person1@org1.example'),
  'two unrelated outsiders are not made colleagues');
assert.ok(/the same sample again/.test(clean), 'a short name cannot eat the inside of a word');
assert.ok(/^Person 1, the same/m.test(clean) && /Thanks Person 1 /.test(clean),
  'but is replaced wherever it stands as a name');
assert.strictEqual(clean.split('\n').length, cap.split('\n').length, 'and no line is added or lost');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('replay: OK');
