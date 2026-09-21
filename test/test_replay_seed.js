/* Real Slack with other people in it, replayed.
 *
 * test_replay.js covers a one-member workspace, which cannot say anything about
 * attribution, ownership or whose turn it is. These are the connector's responses from the
 * first seed run (2026-09-14): two test personas, Lena and Sam, posting the thirteen
 * messages in the seed script into two channels, and a reply to a thread root from the
 * other. Sanitized with tools/sanitize-capture.js --keep "Lena H,Sam M" — the personas'
 * display names are invented, and the detector reads "Lena — can you…" against them.
 *
 * That run found the three rules test_channel.js now guards. This pins what it should
 * have produced, read on the Friday after so that deadlines have come due.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var loops = require('../src/loops.js');
global.OWNER = loops.OWNER;
global.LABEL = loops.LABEL;
global.loopKey = loops.loopKey;
var { parseChannel } = require('../src/slack.js');
var { main } = require('../slack-run.js');

var D = path.join(__dirname, 'replay', '2026-09-14');
var rd = function (f) { return fs.readFileSync(path.join(D, f), 'utf8'); };
var LENA = 'person1@org1.example', SAM = 'person2@org1.example';
var CONTACTS = { 'org1.example': { tier: 'key_account', label: 'Vector Freight' } };
var DANA = [{ label: 'Dana', address: 'dana@example.com' }];
var convs = [{ channel: '#all-open-loops', members: [], text: rd('seed-ch1.txt') },
             { channel: '#new-channel', members: [], text: rd('seed-ch2.txt') }];
var threads = [{ channel: '#new-channel', root: '1789400620.058209', members: [], text: rd('seed-th1.txt') },
               { channel: '#all-open-loops', root: '1788292991.482509', members: [], text: rd('th1.txt') }];

var o = function (c, x) {
  return Object.assign({ channel: c, members: [], tzOffset: -240, self: 'you@example.com', selfUid: 'U0EXAMPLE001' }, x || {});
};
var byId = {};
convs.forEach(function (c) { parseChannel(c.text, o(c.channel)).forEach(function (m) { byId[m.id] = m; }); });
threads.forEach(function (t) { parseChannel(t.text, o(t.channel, { threadId: t.root })).forEach(function (m) { byId[m.id] = m; }); });
var msgs = Object.keys(byId).map(function (k) { return byId[k]; })
  .sort(function (a, b) { return parseFloat(a.id) - parseFloat(b.id); });
var r = loops.detectLoops(msgs, [], { exec: 'you@example.com', today: '2026-09-18', principals: DANA, contacts: CONTACTS });

// Seed items only: the September messages in the same channels are test_replay.js's.
var seed = function (l) { return parseFloat(l.msgId) > 1789000000; };
var find = function (text) {
  var hit = r.open.filter(seed).filter(function (l) { return l.what.indexOf(text) > -1; });
  assert.ok(hit.length <= 1, 'one item for: ' + text);
  return hit[0] || null;
};
var expect = function (n, text, want) {
  var l = find(text);
  if (!want) return assert.strictEqual(l, null, n + ' is not a loop: ' + (l && l.type));
  assert.ok(l, n + ' is found: ' + text);
  assert.strictEqual(l.type, want[0], n + ' type');
  assert.strictEqual(l.owner, want[1], n + ' owner');
  assert.strictEqual(l.who, want[2], n + ' is attributed to ' + want[2] + ', got ' + l.who);
  assert.strictEqual(l.rel ? l.rel.label : null, want[2] ? 'Vector Freight' : null, n + ' tier follows attribution');
};

assert.ok(r.closed.filter(seed).some(function (l) { return /signed MSA back by Tuesday/.test(l.what); }),
  '1: closed by the signed MSA arriving');
expect('2', 'circulate the redline', ['owed_by_us', 'you', null]);
expect('3', 'Q4 headcount plan', ['unanswered_ask', 'you', SAM]);
expect('4', 'confirm the pilot start date', ['awaiting_reply', 'them', LENA]);
expect('5', 'revisit the pricing', null);
expect('6', 'set up a call Thursday', ['agreed_unscheduled', 'you', null]);
expect('7', 'Numbers came in a bit under', null);
expect('8', 'Signed MSA attached', null);
expect('9', 'vendor kickoff', ['unanswered_ask', 'you', SAM]);
expect('10', 'book the pricing review', ['owed_by_us', 'you', null]);
expect('11', 'see how the numbers land', null);
expect('12', 'Sending the updated deck', null);
expect('14', 'scope doc and share it Wednesday', ['owed_to_us', 'them', SAM]);
assert.strictEqual(r.open.filter(seed).length, 7, 'and nothing else from the seed');
assert.strictEqual(find('vendor kickoff').due, '2026-09-14',
  '9: "I need an answer today", in the sentence after the question, is its deadline');

/* Through the runner, supporting Dana: none of the reader's own work goes to her pile. */
var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openloops-seed-'));
fs.writeFileSync(path.join(tmp, 'in.json'), JSON.stringify({ today: '2026-09-18', tzOffset: -240,
  contacts: CONTACTS, conversations: convs, threads: threads }));
fs.writeFileSync(path.join(tmp, 'cfg.json'), JSON.stringify({ you: 'you@example.com', selfDm: 'U0EXAMPLE001',
  supporting: DANA, ledger: path.join(tmp, 'ledger.json') }));
var digest = main([path.join(tmp, 'in.json'), '--config', path.join(tmp, 'cfg.json'), '--dry']);
assert.ok(/Read \d+ messages across 2 conversations/.test(digest), 'the runner reads it');
assert.strictEqual(digest.indexOf('NEEDS DANA'), -1, 'nothing the reader promised is filed as Dana\'s');

/* Tuesday's real run: Sam's "I need an answer today" was a day old and past its deadline,
   and the two-day grace hid it. Lena's undated question still waits its two days. */
var tue = loops.detectLoops(msgs, [], { exec: 'you@example.com', today: '2026-09-15', principals: DANA, contacts: CONTACTS });
var onTue = function (t) { return tue.open.filter(seed).some(function (l) { return l.what.indexOf(t) > -1; }); };
assert.ok(onTue('vendor kickoff'), 'Tuesday: the overdue kickoff question is raised');
assert.ok(!onTue('confirm the pilot start date'), 'and the undated one is still held');

/* --- the digest itself, on the Wednesday the demo is recorded ---
 *
 * The redesign (2026-09-14) was approved against exactly this output: the seed run, read
 * on the 16th with a three-day window. Pinned so the approved shape cannot drift. */
fs.writeFileSync(path.join(tmp, 'wed.json'), JSON.stringify({ today: '2026-09-16', tzOffset: -240,
  conversations: convs, threads: threads }));
fs.writeFileSync(path.join(tmp, 'wcfg.json'), JSON.stringify({ you: 'you@example.com', selfDm: 'U0EXAMPLE001',
  supporting: DANA, contacts: CONTACTS, lookbackDays: 3, replyKey: 'short',
  ledger: path.join(tmp, 'wed-ledger.json') }));
var wed = main([path.join(tmp, 'wed.json'), '--config', path.join(tmp, 'wcfg.json'), '--dry']);
var wBrief = wed.split('-- thread --')[0], wl = wBrief.split('\n'), fi = wl.indexOf('TODAY — highest priority');
assert.ok(fi > -1, 'TODAY leads the brief:\n' + wed);
assert.ok(/^ 1  2d late\s+Answer Sam — "Are we still on for the vendor kickoff\?"$/.test(wl[fi + 1]),
  'first: Sam\'s question, its deadline just arrived: ' + wl[fi + 1]);
assert.ok(/"I need an answer today"/.test(wl[fi + 2]), 'with the sentence its deadline came from: ' + wl[fi + 2]);
assert.ok(/^ 2  today\s+Chase Sam — "I'll put together the scope doc/.test(wl[fi + 3]), 'then what lands today: ' + wl[fi + 3]);
assert.ok(/^ 3  Thu\s+Answer Sam — "Can you review the Q4 headcount plan/.test(wl[fi + 5]), 'then what lands tomorrow: ' + wl[fi + 5]);
assert.ok(/^1 overdue · 1 due today · 3 due by Fri · 7 open$/m.test(wBrief), 'the state of the day in one line');
assert.strictEqual(wBrief.split('Are we still on for the vendor kickoff').length - 1, 1, 'every loop appears once in the brief');
assert.ok(!/date from Lena's "by Tuesday"/.test(wed), 'an unrelated channel promise cannot date the redline follow-up');
assert.ok(/closed Mon by Lena: "Signed MSA attached — sorry for the delay\."/.test(wed),
  'and a closed one says what closed it');
assert.ok(!/@org1\.example/.test(wed), 'people by name, not address');
assert.strictEqual((wed.split('SPOT CHECK')[1] || '').indexOf('Signed MSA attached'), -1,
  'the closing message is not offered as one it found nothing in');
assert.ok(/^Reply  3 7 not real/m.test(wBrief) && !/isn't real/.test(wed), 'the key only, as configured');

/* The same day through a three-week window, which is what the daily run reads — seventeen
   items, a dozen of them two-week-old test promises. On 2026-09-16 the brief led with
   two of those, ahead of Sam's scope doc due that day, which did not make the brief at
   all. What has just come due goes first; the old promises lead the one-liners. */
fs.writeFileSync(path.join(tmp, 'dcfg.json'), JSON.stringify({ you: 'you@example.com', selfDm: 'U0EXAMPLE001',
  contacts: CONTACTS, lookbackDays: 21, ledger: path.join(tmp, 'daily-ledger.json') }));
var daily = main([path.join(tmp, 'wed.json'), '--config', path.join(tmp, 'dcfg.json'), '--dry']).split('-- thread --')[0];
var dToday = daily.split('TODAY — highest priority')[1].split('\n\n')[0];
var dRows = dToday.split('\n').filter(function (l) { return /^ ?\d+  \S/.test(l); });
[/^ 1  2d late\s+Answer Sam — "Are we still on for the vendor kickoff/,
 /^ 2  1d late\s+You promised — "I'll have the revenue numbers over to finance/,
 /^ 3  today\s+Chase Sam — "I'll put together the scope doc/
].forEach(function (rx, i) {
  assert.ok(rx.test(dRows[i] || ''), 'what has just come due, then what lands today:\n' + dToday);
});
assert.ok(/ALSO OPEN[\s\S]*14d late/.test(daily), 'and the two-week-old promises lead what follows');

/* Friday, the same data. The real run that day dropped Sam's kickoff question — asked
   Monday, "I need an answer today", still unanswered — to sixth, because four days late
   had aged it out of "just arrived". Somebody waiting on you does not age out. */
fs.writeFileSync(path.join(tmp, 'fri.json'), JSON.stringify({ today: '2026-09-18', tzOffset: -240,
  conversations: convs, threads: threads }));
var fri = main([path.join(tmp, 'fri.json'), '--config', path.join(tmp, 'dcfg.json'), '--dry']).split('-- thread --')[0];
var fRows = fri.split('TODAY — highest priority')[1].split('\n\n')[0].split('\n')
  .filter(function (l) { return /^ ?\d+  \S/.test(l); });
[/^ 1  4d late\s+Answer Sam — "Are we still on for the vendor kickoff/,
 /^ 2  1d late\s+Answer Sam — "Can you review the Q4 headcount plan/,
 // Then the rest of the just-arrived group by risk — here Sam's scope doc, which carries
 // the key-account weight this fixture gives his company (the live config has none, so
 // there it was the revenue-numbers promise).
 /^ 3  2d late\s+Chase Sam — "I'll put together the scope doc/
].forEach(function (rx, i) {
  assert.ok(rx.test(fRows[i] || ''), 'Friday: the questions waiting on you first:\n' + fRows.join('\n'));
});

console.log('test_replay_seed: ok');
