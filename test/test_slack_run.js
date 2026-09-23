/* The Slack runner, end to end: connector text in, digest out, corrections back.
 *
 * The workspace this was written against is empty, so the conversations below are
 * invented — the same standard the demo fixture is held to. They exist to exercise
 * the pipeline, not to prove anything about accuracy on real chatter. */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var { main } = require('../slack-run.js');
global.loopKey = require('../src/loops.js').loopKey;
var L = require('../src/ledger.js');

var ME = 'you@example.com';
var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openloops-slack-'));
var ledger = path.join(dir, 'ledger.json');

/* Build the connector's display format, which is what the adapter actually parses. */
var at = function (y, mo, d, h) { return (Date.UTC(y, mo - 1, d, h) / 1000).toFixed(6); };
var msg = function (name, email, uid, ts, body) {
  return ['=== Message from ' + name + ' <' + email + '> (' + uid + ') at ' + ts + ' UTC ===',
          'Message TS: ' + ts, body].join('\n');
};
var me = function (ts, body) { return msg('Alex Rivera', ME, 'U0EXAMPLE001', ts, body); };
var them = function (name, email, uid, ts, body) { return msg(name, email, uid, ts, body); };

var input = {
  self: ME,
  today: '2026-09-01',
  tzOffset: 0,
  conversations: [
    { channel: '#vector-freight', members: ['lena@vectorfreight.com'], text: [
      them('Lena Borg', 'lena@vectorfreight.com', 'U01', at(2026, 8, 20, 10),
        "We'll get the revised contract back to you Friday Aug 28."),
      me(at(2026, 8, 21, 9), 'Perfect, thanks Lena.')
    ].join('\n') },
    { channel: '#northstar-internal', members: ['rachel@northstar.io'], text: [
      them('Rachel Kim', 'rachel@northstar.io', 'U02', at(2026, 8, 27, 14),
        'Can you confirm the offsite headcount by Monday?'),
      me(at(2026, 8, 28, 9), "I'll pull the numbers and confirm Monday.")
    ].join('\n') },
    { channel: '#halcyon', members: ['sana@halcyon.io'], text: [
      me(at(2026, 8, 25, 11), "I'll put together a scope doc and send it Wednesday."),
      them('Sana Iyer', 'sana@halcyon.io', 'U03', at(2026, 8, 25, 12), 'Great, looking forward to it.')
    ].join('\n') }
  ],
  dm: { channel: 'D0EXAMPLE001', text: '' }
};

var write = function (o) {
  var p = path.join(dir, 'in.json');
  fs.writeFileSync(p, JSON.stringify(o));
  return p;
};

/* ------------------------------ first run ------------------------------ */
var text = main([write(input), '--ledger', ledger]);

assert.ok(text.indexOf('OPEN LOOPS — for 2026-09-01') === 0, 'the digest is dated');
assert.ok(/Read 6 messages across 3 conversations/.test(text),
  'and says conversations, not threads: ' + text.split('\n')[4]);
assert.ok(/^\d+ overdue · /m.test(text), 'the counts line leads with what is overdue');

/* Promises in both directions, found in Slack exactly as they are in mail. */
assert.ok(text.indexOf("We'll get the revised contract back to you Friday Aug 28.") > -1,
  'an inbound promise from a counterparty');
assert.ok(text.indexOf("I'll put together a scope doc and send it Wednesday.") > -1,
  'and an outbound one of your own');
assert.ok(text.indexOf('#vector-freight') > -1, 'the channel name stands in for a subject');

/* Numbered, because a reply quotes the number back. */
// The brief, numbered in the order it reads — a reply's numbers match what was read.
var numbered = text.split('-- thread --')[0].split('\n').filter(function (l) { return /^ ?\d+  \S/.test(l); });
assert.ok(numbered.length >= 3, 'every open item is numbered, got ' + numbered.length);
numbered.forEach(function (line, i) {
  assert.strictEqual(parseInt(line, 10), i + 1, 'numbering is contiguous: ' + line);
});
assert.ok(!/NEW|\d+ new/.test(text), 'on a cold ledger everything is new, so nothing needs marking new');

/* ------------- the next day: the same conversations are not news ------------- */
// Dated the next day: a second run on the same date replaces the first (see further down).
var on = function (d) { var o = JSON.parse(JSON.stringify(input)); o.today = d; return write(o); };
var again = main([on('2026-09-02'), '--ledger', ledger]);
assert.ok(!/\d+ new/.test(again) && /1d on the list/.test(again),
  'nothing is new the next day, and each item says how long it has sat');
assert.ok(again.indexOf('NEW · ') === -1, 'and no item is still flagged new');

/* ------------- a correction, typed into the DM under the digest ------------- */
// Item 1's own words, from whichever line quotes it — its pile row, or FIRST if spotlit.
var row1 = text.split('\n').filter(function (l) { return /^ 1  /.test(l) && /"/.test(l); })[0];
var firstItem = row1.match(/"(.+)"/)[1].replace(/…$/, '');
input.dm.text = [
  me(at(2026, 9, 1, 18), '```\n' + text + '\n```'),   // the digest, as it was posted
  me(at(2026, 9, 1, 19), '1')                          // "number 1 is not real"
].join('\n');

var third = main([on('2026-09-03'), '--ledger', ledger]);
assert.ok(/Took your last reply — 1 marked not real, dropped for good/.test(third),
  'the correction is acknowledged: ' + third.split('\n').slice(4, 8).join(' | '));
assert.strictEqual(third.indexOf(firstItem), -1, 'and that item is gone: ' + firstItem);
assert.ok(/1 hidden as wrong/.test(third), 'the count says something is being hidden');

/* The instructions in full until the reader has answered once — that paragraph teaches
   the loop — and a two-line key after, because nobody rereads it every evening. */
assert.ok(/isn't real/.test(text), 'the first digest explains replies in full');
assert.ok(/^Reply  3 7 not real/m.test(third) && !/isn't real/.test(third), 'once answered, the key is enough');

/* ---------------- replies typed in the digest's thread ----------------
 * The details are posted as a reply under the digest, so the thread is where a reader
 * is when they decide an item is wrong — and a thread reply is not in a read of the DM.
 * The details message itself sits in that thread and contains "3 7"; it is not a reply. */
var tLedger = path.join(dir, 'thread.json');
var tFirst = main([write(input), '--ledger', tLedger]);
var tBrief = tFirst.split('-- thread --')[0].trim(), tDetails = tFirst.split('-- thread --')[1].trim();
var threadRead = function (parentTs, parentBody, replies) {
  var who = function () { return 'From: Alex Rivera <' + ME + '> (U0EXAMPLE001)'; };
  var out = ['=== THREAD PARENT MESSAGE ===', who(), 'Time: 2026-09-01 18:00:00 UTC', 'Message TS: ' + parentTs,
             parentBody, '', '=== THREAD REPLIES (' + replies.length + ' total) ===', ''];
  replies.forEach(function (r, i) {
    out.push('--- Reply ' + (i + 1) + ' of ' + replies.length + ' ---', who(),
             'Time: 2026-09-01 19:00:00 UTC', 'Message TS: ' + r[0], r[1], '');
  });
  return out.join('\n');
};
var dTs = at(2026, 9, 1, 18);
var threaded2 = JSON.parse(JSON.stringify(input));
threaded2.today = '2026-09-02';
threaded2.dm = { channel: 'D0', text: me(dTs, '```\n' + tBrief + '\n```') };
threaded2.dmThread = { text: threadRead(dTs, '```\n' + tBrief + '\n```', [
  [at(2026, 9, 1, 18) .replace(/\.0+$/, '.000100'), '```\n' + tDetails + '\n```'],
  // Its own timestamp: the '1' in input.dm above is a different message, under another
  // ledger's digest, and a reply is recognised by its timestamp.
  [at(2026, 9, 1, 19).replace(/\.0+$/, '.000200'), '1']
]) };
var tNext = main([write(threaded2), '--ledger', tLedger]);
assert.ok(/Took your last reply — 1 marked not real, dropped for good/.test(tNext),
  'a reply in the thread is read, and the details beside it are not: ' +
  (tNext.match(/Took your last reply[^\n]*/) || ['(no acknowledgement)'])[0]);

/* The DM read only since the latest digest (2026-09-21): 36 KB of a 52 KB input was old
   digests, retyped by hand, and that is where the copying errors were. So `dm` now holds
   only what came after the digest — it no longer contains the digest at all, which comes
   from the thread read — and a reply typed straight into the DM still lands. A reply
   older than the digest belongs to an earlier list and is not applied to this one. */
var sLedger = path.join(dir, 'since.json');
var sFirst = main([write(input), '--ledger', sLedger]);
var sBrief = sFirst.split('-- thread --')[0].trim(), sDetails = sFirst.split('-- thread --')[1].trim();
var since = JSON.parse(JSON.stringify(input));
since.today = '2026-09-02';
since.dmThread = { text: threadRead(dTs, '```\n' + sBrief + '\n```', [
  [at(2026, 9, 1, 18).replace(/\.0+$/, '.000100'), '```\n' + sDetails + '\n```']
]) };
since.dm = { channel: 'D0', text: [
  me(at(2026, 9, 1, 20), '1'),                         // after the digest: a reply to it
  me(at(2026, 9, 1, 17), '2')                          // before it: not a reply to this list
].join('\n') };
var sNext = main([write(since), '--ledger', sLedger]);
assert.ok(/Took your last reply — 1 marked not real, dropped for good/.test(sNext),
  'a reply typed in the DM after the digest is read, and only that one: ' +
  (sNext.match(/Took your last reply[^\n]*/) || ['(no acknowledgement)'])[0]);

/* ---------------- a reply belongs to the digest it answers ----------------
 * 2026-09-22: a second setup posted its own digest into the same DM from its own ledger.
 * "k 4" meant its #4 and marked this ledger's #4, because the two were matched by date.
 * Each digest now carries a reference, and the ledger remembers which list each one
 * numbered — including a same-day re-run's, where two lists share a date. */
var fresh = function (today) {
  var o = JSON.parse(JSON.stringify(input));
  o.today = today; o.dm = { channel: 'D0', text: '' }; delete o.dmThread;
  return o;
};
var halves = function (t) { return { brief: t.split('-- thread --')[0].trim(), details: t.split('-- thread --')[1].trim() }; };
var itemAt = function (t, n) {
  var r = halves(t).brief.split('\n').filter(function (l) { return l.indexOf(' ' + n + '  ') === 0 && /"/.test(l); })[0];
  return r ? r.match(/"(.+)"/)[1].replace(/…$/, '') : null;
};
var refOf = function (t) { return (t.split('\n')[0].match(/· ref ([0-9a-f]{4})$/) || [])[1]; };
var digestThread = function (ts, t, replies) {
  var h = halves(t);
  return { root: ts, text: threadRead(ts, '```\n' + h.brief + '\n```',
    [[ts.replace(/\.0+$/, '.000100'), '```\n' + h.details + '\n```']].concat(replies)) };
};

var oursRun = main([write(fresh('2026-09-01')), '--ledger', path.join(dir, 'ours.json')]);
assert.ok(refOf(oursRun), 'the header carries a reference: ' + oursRun.split('\n')[0]);
assert.strictEqual(main([write(fresh('2026-09-01')), '--ledger', path.join(dir, 'ours.json'), '--dry']).split('\n')[0],
  oursRun.split('\n')[0], 'the same list numbered the same way gets the same reference');

// Another setup's digest in the same DM, answered: its own ledger, a different list.
var theirsIn = fresh('2026-09-01');
theirsIn.conversations = theirsIn.conversations.slice(1);
var theirsRun = main([write(theirsIn), '--ledger', path.join(dir, 'theirs.json')]);
var theirRef = refOf(theirsRun);
assert.ok(theirRef && theirRef !== refOf(oursRun), 'precondition: a different list has a different reference');
var alien = fresh('2026-09-02');
alien.dmThread = digestThread(at(2026, 9, 1, 18), theirsRun,
  [[at(2026, 9, 1, 19).replace(/\.0+$/, '.000300'), '1']]);
var alienNext = main([write(alien), '--ledger', path.join(dir, 'ours.json')]);
assert.ok(!/Took your last reply/.test(alienNext), 'a reply to a digest this ledger did not produce is not applied');
assert.ok(!/hidden as wrong/.test(alienNext) && alienNext.indexOf(itemAt(oursRun, 1)) !== -1,
  'and nothing is hidden by it');
assert.ok(new RegExp('NOT APPLIED — "1" answers a digest this ledger did not produce \\(2026-09-01, ref ' +
  theirRef + '\\)').test(alienNext),
  'the reader is told why: ' + (alienNext.match(/NOT APPLIED[^\n]*/) || ['(nothing said)'])[0]);
alien.today = '2026-09-03';
assert.ok(!/NOT APPLIED/.test(main([write(alien), '--ledger', path.join(dir, 'ours.json')])),
  'once, not every day');

/* A re-run numbers a different list. A reply typed under the first run's digest before it
   meant the first run's item — not whatever holds that number now. */
var reLedger = path.join(dir, 'rerun.json');
var reDay1 = fresh('2026-09-02');
var reFirst = main([write(reDay1), '--ledger', reLedger]);
var later = fresh('2026-09-02');
later.conversations[2].text += '\n' + them('Sana Iyer', 'sana@halcyon.io', 'U03', at(2026, 9, 2, 12),
  'Can you send the signed NDA by today? Legal needs it before noon.');
var dryAgain = main([write(later), '--ledger', reLedger, '--dry']);
var n = [1, 2, 3].filter(function (k) { return itemAt(reFirst, k) !== itemAt(dryAgain, k); })[0];
assert.ok(n, 'precondition: the re-run numbers its list differently');
later.dmThread = [digestThread(at(2026, 9, 2, 10), reFirst, [[at(2026, 9, 2, 11), String(n)]])];
var reAgain = main([write(later), '--ledger', reLedger]);
assert.ok(/Took your last reply — 1 marked not real/.test(reAgain), 'the reply to the first run is applied');
assert.strictEqual(reAgain.indexOf(itemAt(reFirst, n)), -1, 'to the item it pointed at then: ' + itemAt(reFirst, n));
assert.ok(reAgain.indexOf(itemAt(dryAgain, n)) !== -1, 'not the one holding that number now: ' + itemAt(dryAgain, n));
// The item was new in the rolled-back run, so the reply made its row — and it keeps its words.
var rejectedRow = JSON.parse(fs.readFileSync(reLedger, 'utf8')).rows.filter(function (r) { return r[L.COL.verdict] === 'x'; })[0];
assert.ok(rejectedRow && rejectedRow[L.COL.what].indexOf(itemAt(reFirst, n)) === 0,
  'the rejected row says what it rejected: ' + JSON.stringify(rejectedRow));

/* A re-run reads yesterday's thread and today's: the day was rolled back, so both sets of
   corrections apply again — each once. "k" keeps its item and says so. */
var twoLedger = path.join(dir, 'two.json');
var d1 = main([write(fresh('2026-09-01')), '--ledger', twoLedger]);
var day2 = fresh('2026-09-02');
day2.dmThread = [digestThread(at(2026, 9, 1, 18), d1, [[at(2026, 9, 1, 19), '1']])];
var d2 = main([write(day2), '--ledger', twoLedger]);
assert.ok(!/DM READ/.test(d2), 'a first run of the day read from yesterday: no warning');
var gone1 = itemAt(d1, 1), gone2 = itemAt(d2, 2), kept3 = itemAt(d2, 3);
day2.dmThread.push(digestThread(at(2026, 9, 2, 18), d2,
  [[at(2026, 9, 2, 19), '2'], [at(2026, 9, 2, 20), 'k 3']]));
var d2again = main([write(day2), '--ledger', twoLedger]);
assert.ok(/Took your last reply — 2 marked not real, dropped for good · 1 marked already known\./.test(d2again),
  'both threads, each reply once, and k is not called a rejection: ' +
  (d2again.match(/Took your last reply[^\n]*/) || ['(no acknowledgement)'])[0]);
assert.ok(d2again.indexOf(gone1) === -1 && d2again.indexOf(gone2) === -1, 'both rejections hold');
assert.ok(d2again.indexOf(kept3) !== -1, 'the known item stays listed');
assert.ok(/2 hidden as wrong/.test(d2again), 'hidden twice, not four times');
assert.ok(!/DM READ/.test(d2again), 'read from yesterday: no warning');

// The same re-run given only today's thread: yesterday's corrections were never read.
day2.dmThread = [day2.dmThread[1]];
var d2short = main([write(day2), '--ledger', twoLedger, '--dry']);
assert.ok(/DM READ — started at today's own digest/.test(d2short),
  'a read that began at today\'s digest says so: ' + (d2short.match(/DM READ[^\n]*/) || ['(nothing said)'])[0]);

/* Someone else's promise, typed by the reader, supporting nobody: chased, and the note
   under it is a chase too (2026-09-22: it said "Hi Dana — I still owe you this"). */
var danaIn = fresh('2026-09-02');
danaIn.conversations = [{ channel: '#launch', text: me(at(2026, 9, 1, 15),
  'Dana will review the board deck by tomorrow.') }];
var dana = main([write(danaIn), '--ledger', path.join(dir, 'dana.json'), '--dry']);
assert.ok(/Chase Dana — "Dana will review the board deck by tomorrow\."/.test(dana), 'precondition: it is Dana\'s to chase');
assert.ok(/→ Hi Dana — checking in on this/.test(dana) && !/still owe you/.test(dana),
  'and the draft chases Dana: ' + (dana.match(/→[^\n]*/) || ['(no draft)'])[0]);

/* The same reply must not be re-read. It stays in the DM forever, and re-applying it
   against a now-shorter list would mark a different item every single run. */
var fourth = main([on('2026-09-04'), '--ledger', ledger]);
assert.ok(!/Took your last reply/.test(fourth), 'a reply is acted on exactly once');
assert.ok(/1 hidden as wrong/.test(fourth), 'but what it rejected stays rejected');

/* A digest is not a reply to itself — its own instruction lines contain "3 7". */
assert.ok(!/Took your last reply — [2-9]/.test(third),
  'the posted digest must not be parsed as a correction to itself');

/* ------------------------------- --dry ------------------------------- */
var before = fs.readFileSync(ledger, 'utf8');
main([write(input), '--ledger', ledger, '--dry']);
assert.strictEqual(fs.readFileSync(ledger, 'utf8'), before,
  '--dry renders without recording, so reading it by hand costs nothing');

/* --------------------- who you support, if anyone --------------------- */

/* Running it over your own Slack is the common case, and the digest must not sort
   your own work into a pile named after an executive who does not exist. */
var soloLedger = path.join(dir, 'solo.json');
var soloText = main([write(input), '--ledger', soloLedger]);
assert.strictEqual(soloText.indexOf('NEEDS THE EXECUTIVE'), -1,
  'no executive pile when you support nobody');
assert.ok(soloText.indexOf('YOURS TO HANDLE') > -1, 'that work is simply yours');

/* Supporting one person keeps the split and names them. What lands there is what was
   promised in their name; the reader's own "I'll…" stays the reader's. */
var relay = function (o, lines) {
  lines.forEach(function (b, i) { o.conversations[2].text += '\n' + me(at(2026, 8, 26, 9 + i), b); });
  return o;
};
var named = relay(JSON.parse(JSON.stringify(input)), ['Dana will send the signed MSA Friday.']);
named.principals = [{ label: 'Dana' }];
var namedText = main([write(named), '--ledger', path.join(dir, 'named.json')]);
assert.ok(namedText.indexOf('NEEDS DANA') > -1, 'the pile is named after the person: ' +
  namedText.split('\n').filter(function (l) { return /\(\d+\) —/.test(l); }).join(' | '));
assert.strictEqual(namedText.indexOf('NEEDS THE EXECUTIVE'), -1, 'and not after a job title');

/* Supporting several puts the name on each item, since one heading cannot carry two. */
var multi = relay(JSON.parse(JSON.stringify(input)),
  ['Dana will send the signed MSA Friday.', 'Marcus will send the headcount numbers Monday.']);
multi.principals = [
  { label: 'Dana', address: 'sana@halcyon.io' },
  { label: 'Marcus', address: 'rachel@northstar.io' }
];
var multiText = main([write(multi), '--ledger', path.join(dir, 'multi.json')]);
assert.ok(/for Dana · /.test(multiText) && /for Marcus · /.test(multiText),
  'each item says whose it is when the heading cannot');

/* ------------------- thread replies are a second fetch ------------------- */

/* A channel read announces that a root has replies but does not include them, so a
   promise made inside a thread is simply absent. Absent and silent is worse than
   absent and stated. */
var threaded = {
  self: ME, today: '2026-09-01', tzOffset: 0, principals: [],
  conversations: [{ channel: '#halcyon', members: ['sana@halcyon.io'], text: [
    msg('Alex Rivera', ME, 'U0EXAMPLE001', at(2026, 8, 30, 10), 'Halcyon pilot — scoping thread.'),
    'Thread: 1 replies (latest: 2026-08-30 11:00:00 UTC)'
  ].join('\n') }]
};
var missing = main([write(threaded), '--ledger', path.join(dir, 't1.json')]);
assert.ok(/1 thread had replies that were not read/.test(missing),
  'the digest says what it could not see');

/* Supplied, the promise inside it appears — and the root is not duplicated, even
   though a thread read repeats it. */
threaded.threads = [{ channel: '#halcyon', root: at(2026, 8, 30, 10), members: ['sana@halcyon.io'], text: [
  '=== THREAD PARENT MESSAGE ===',
  'From: Alex Rivera <' + ME + '> (U0EXAMPLE001)',
  'Message TS: ' + at(2026, 8, 30, 10),
  'Halcyon pilot — scoping thread.',
  '',
  '=== THREAD REPLIES (1 total) ===',
  '',
  '--- Reply 1 of 1 ---',
  'From: Alex Rivera <' + ME + '> (U0EXAMPLE001)',
  'Message TS: ' + at(2026, 8, 30, 11),
  "I'll put together the scope doc and share it Wednesday."
].join('\n') }];

var fetched = main([write(threaded), '--ledger', path.join(dir, 't2.json')]);
assert.ok(!/replies that were not read/.test(fetched), 'nothing outstanding once it is fetched');
assert.ok(fetched.indexOf('scope doc') > -1, 'and the promise inside the thread is found');
assert.ok(/Read 2 messages/.test(fetched),
  'the root is not counted twice, though a thread read repeats it: ' +
  fetched.split('\n').filter(function (l) { return /^Read /.test(l); })[0]);

/* -------------------- muting a kind, not just an instance -------------------- */
var vague = {
  self: ME, today: '2026-09-01', tzOffset: 0, principals: [],
  conversations: [{ channel: '#chat', members: [], text: [
    me(at(2026, 8, 30, 10), "We'll revisit pricing at some point."),
    me(at(2026, 8, 30, 11), "I'll send the deck Thursday.")
  ].join('\n') }]
};
var loud = main([write(vague), '--ledger', path.join(dir, 'm1.json')]);
assert.ok(loud.indexOf('revisit pricing') > -1, 'without a mute it is raised');

vague.mute = ['at some point'];
var quiet = main([write(vague), '--ledger', path.join(dir, 'm2.json')]);
assert.strictEqual(quiet.indexOf('revisit pricing'), -1, 'muted by phrase');
assert.ok(quiet.indexOf('send the deck') > -1, 'and nothing else is touched');
assert.ok(/1 item was muted by phrase/.test(quiet), 'the digest says it dropped something');

/* Muted items must not reach the ledger at all — otherwise they accumulate there as
   permanent false positives and drag the precision number down forever. */
var afterMute = JSON.parse(fs.readFileSync(path.join(dir, 'm2.json'), 'utf8'));
assert.strictEqual(afterMute.rows.length, 1, 'only the surviving item is tracked');

/* --------------------- checking what it never showed --------------------- */

/* Everything else in the loop asks about items that appeared. A miss produces nothing
   to reject, so the only evidence about recall is sampling the silence. */
var quietLedger = path.join(dir, 'quiet.json');
var quietInput = {
  self: ME, today: '2026-09-01', tzOffset: 0, principals: [], spotCheck: 3,
  conversations: [{ channel: '#chat', members: [], text: [
    me(at(2026, 8, 28, 9), "I'll send the deck Thursday."),
    me(at(2026, 8, 28, 10), 'The vendor call went fine, nothing blocking on our side.'),
    me(at(2026, 8, 28, 11), 'Numbers are up 4% quarter on quarter, worth a mention.'),
    me(at(2026, 8, 28, 12), 'Reminder that the office is closed Monday for the holiday.'),
    me(at(2026, 8, 28, 13), 'Docs are updated if anyone needs the new endpoints.')
  ].join('\n') }]
};

var checked = main([write(quietInput), '--ledger', quietLedger]);
assert.ok(/SPOT CHECK/.test(checked), 'it asks about what it stayed silent on');
var lettered = checked.split('\n').filter(function (l) { return /^  [a-c]  \S/.test(l); });
assert.strictEqual(lettered.length, 3, 'three sampled, lettered not numbered');
assert.ok(/Reply "miss b d"/.test(checked), 'and says how to answer');

/* A message it did find something in is not silence — it spoke and you may disagree,
   which is a rejection, not a miss. It must never be offered back as unexamined. */
assert.ok(lettered.every(function (l) { return l.indexOf('send the deck') === -1; }),
  'the detected message is not among the sampled: ' + lettered.join(' | '));

var askedIds = JSON.parse(fs.readFileSync(quietLedger, 'utf8')).audit.asked['2026-09-01'];
assert.strictEqual(askedIds.length, 3, 'what was asked is recorded against the digest date');

/* The sample must not reshuffle between runs, or yesterday's answer lines up with
   nothing. */
var again2 = main([write(quietInput), '--ledger', path.join(dir, 'quiet2.json')]);
assert.deepStrictEqual(
  again2.split('\n').filter(function (l) { return /^  [a-c]  \S/.test(l); }), lettered,
  'the same day samples the same messages');

/* Answering it. "miss b" flags one; the rest of what was asked counts as checked. */
quietInput.dm = { channel: 'D0', text: [
  me(at(2026, 9, 1, 18), '```\n' + checked + '\n```'),
  me(at(2026, 9, 1, 19), 'miss b')
].join('\n') };
quietInput.today = '2026-09-02';   // answered the next day — a same-date run would replace the one it answers
var scored = main([write(quietInput), '--ledger', quietLedger]);
var st2 = JSON.parse(fs.readFileSync(quietLedger, 'utf8'));
assert.strictEqual(st2.audit.checked, 3, 'answering counts everything asked, not just the misses');
assert.strictEqual(st2.audit.missed.length, 1, 'and records the one flagged');
assert.strictEqual(st2.audit.missed[0].id, askedIds[1], 'letter b resolves to the second asked');
assert.ok(/Recall so far: about \d+%/.test(scored), 'which becomes a number: ' +
  scored.split('\n').filter(function (l) { return /Recall so far/.test(l); })[0]);

/* And the report has to say the same thing. It reads the ledger alone and never sees
   the messages, so it must be told how big the silent pool was. Without that the
   extrapolation collapses to the raw miss count, and the report reads far more
   flattering than the digest does off the very same rows. */
var pct = function (text, label) {
  var m = text.match(new RegExp(label + ': about (\\d+)%'));
  return m && m[1];
};
assert.strictEqual(pct(main(['--report', '--ledger', quietLedger]), 'Recall'),
  pct(scored, 'Recall so far'),
  'the report and the digest state the same recall off the same ledger');

/* A reply naming no misses is still evidence — without counting those, the
   denominator only grows when something was wrong and the rate is meaningless. */
assert.deepStrictEqual(L.parseMarks('miss', 10).missed, [], 'bare "miss" flags nothing');
assert.deepStrictEqual(L.parseMarks('miss b d', 10).missed, ['b', 'd']);
assert.deepStrictEqual(L.parseMarks('3 7\nmiss a', 10),
  { wrong: [3, 7], knew: [], missed: ['a'], ignored: [], answered: true },
  'rejections and misses in one reply');

/* --- answering the spot check, and not answering it ---
 *
 * `missed: []` means two different things and only one of them is evidence: a bare
 * "miss" is the reader saying none of these were missed, and no miss line at all is
 * the reader not having looked. `answered` is what separates them. */
assert.strictEqual(L.parseMarks('miss', 10).answered, true, 'bare miss is an answer');
assert.strictEqual(L.parseMarks('miss b', 10).answered, true);
assert.strictEqual(L.parseMarks('3 7', 10).answered, false, 'rejecting items is not');
assert.strictEqual(L.parseMarks('k 1 4', 10).answered, false);
assert.strictEqual(L.parseMarks('remember to call Dana', 10).answered, false,
  'and neither is a note to yourself in your own DM');

/* ------------------- learning a mute without being told ------------------- */

/* Four rejections of the same phrase, none of them kept, and it mutes itself. The bar
   is high on purpose: once muted, matching items stop becoming rows, so no further
   evidence accumulates and a wrong mute would never argue its way back. */
var learnLedger = path.join(dir, 'learn.json');
var learnInput = {
  self: ME, today: '2026-09-01', tzOffset: 0, principals: [],
  /* Varied on purpose. Four identical sentences would make every n-gram in them equally
     common, and the longest would win — correct, but it would learn a whole sentence
     rather than the phrase the sentences share. */
  conversations: [{ channel: '#chat', members: [], text: [
    "We'll revisit pricing at some point.",
    "I'll look at the headcount plan at some point.",
    "We'll need to redo the onboarding docs at some point.",
    "I'll get to the backlog grooming at some point.",
    "I'll send the deck Thursday."
  ].map(function (body, n) { return me(at(2026, 8, 21 + n, 10), body); }).join('\n') }]
};

var first = main([write(learnInput), '--ledger', learnLedger]);
assert.ok(!/LEARNED/.test(first), 'nothing is learned before anything is rejected');
assert.strictEqual(JSON.parse(fs.readFileSync(learnLedger, 'utf8')).rows.length, 5);

/* Reject the four vague ones, keep the real one. */
var st = JSON.parse(fs.readFileSync(learnLedger, 'utf8'));
st.rows.forEach(function (r) { if (/at some point/.test(r[6])) r[7] = 'x'; });
fs.writeFileSync(learnLedger, JSON.stringify(st));

learnInput.today = '2026-09-02';   // each run its own day — a same-date run replaces the last
var second = main([write(learnInput), '--ledger', learnLedger]);
assert.ok(/LEARNED/.test(second), 'the pattern is learned: ' +
  second.split('\n').filter(function (l) { return /LEARNED|"at some/.test(l); }).join(' | '));
assert.ok(/"at some point" — rejected 4 times, kept none/.test(second));
assert.ok(/Add it to `unmute`/.test(second), 'and the way to undo it is on the page');

var saved = JSON.parse(fs.readFileSync(learnLedger, 'utf8')).learned;
assert.strictEqual(saved.length, 1, 'recorded in the ledger, not in config');
assert.strictEqual(saved[0].phrase, 'at some point');
assert.strictEqual(saved[0].count, 4, 'with the evidence it acted on');
assert.strictEqual(saved[0].since, '2026-09-02');

/* From now on it applies without being told, and says that it is. */
learnInput.today = '2026-09-03';
var third = main([write(learnInput), '--ledger', learnLedger]);
assert.ok(!/LEARNED/.test(third), 'announced once, not every run');
assert.ok(/Currently muting on its own: "at some point"/.test(third),
  'but standing state that shapes the list stays visible');
assert.ok(/4 items were muted by phrase/.test(third));

/* --report is the one output that is otherwise pure numbers, which makes it the one
   somebody pastes to a colleague when asked how the thing has been doing. The muted
   phrases are literal runs of words out of their own messages — that is how mute
   learning works — so the report has to say where they came from. Nobody should find
   out afterwards that a client name went along with their accuracy figures. */
var shared = main(['--report', '--ledger', learnLedger]);
assert.ok(/phrases from your own messages/.test(shared),
  'the report warns that the muted phrases are the reader\'s own words:\n' + shared);
var warnAt = shared.indexOf('phrases from your own messages');
assert.ok(warnAt > -1 && shared.indexOf('"at some point"', warnAt) > warnAt,
  'and the warning comes before the phrases, not after them');

/* Overruling it stops the phrase being muted. The rows themselves stay rejected —
   those are two different decisions and undoing one must not undo the other. */
learnInput.unmute = ['at some point'];
learnInput.today = '2026-09-04';
var undone = main([write(learnInput), '--ledger', learnLedger]);
assert.ok(!/Currently muting on its own/.test(undone), 'unmute wins over what it taught itself');
assert.ok(!/muted by phrase/.test(undone), 'nothing is being dropped by phrase any more');
assert.ok(/4 hidden as wrong/.test(undone),
  'they are held back by their own verdicts now, which is a different fact: ' +
  undone.split('\n').filter(function (l) { return /open ·/.test(l); })[0]);

/* ----------------------------- the read window ----------------------------- */

/* An unthreaded channel has no boundary of its own, so this window is the only thing
   bounding closure matching there. It was documented before it existed. */
var aged = JSON.parse(JSON.stringify(input));
aged.conversations = [{ channel: '#old', members: [], text: [
  me(at(2026, 6, 1, 10), "I'll send the archive index next week."),   // three months back
  me(at(2026, 8, 30, 10), "I'll send the pricing sheet Thursday.")
].join('\n') }];
delete aged.threads;

/* Unbounded is the wrong default for anyone but the person who wrote it, so absent
   means twenty-one days rather than everything. 0 is how you ask for no window. */
aged.lookbackDays = 0;
var wide = main([write(aged), '--ledger', path.join(dir, 'w1.json')]);
assert.ok(wide.indexOf('archive index') > -1, 'zero means no window at all');

delete aged.lookbackDays;
assert.strictEqual(
  main([write(aged), '--ledger', path.join(dir, 'w0.json')]).indexOf('archive index'), -1,
  'and leaving it out takes the default rather than reading everything ever said');

aged.lookbackDays = 21;
var narrow = main([write(aged), '--ledger', path.join(dir, 'w2.json')]);
assert.strictEqual(narrow.indexOf('archive index'), -1, 'the old promise ages out');
assert.ok(narrow.indexOf('pricing sheet') > -1, 'the recent one stays');
assert.ok(/going back 21 days/.test(narrow),
  'and the digest states the boundary everything else was judged inside');

/* ------------------------- what may be read at all ------------------------- */
var { inScope, nameMatches } = require('../slack-run.js');

assert.ok(nameMatches('#deals', 'deals'), 'the leading hash is noise on both sides');
assert.ok(nameMatches('deals', '#deals'));
assert.ok(nameMatches('#Deals', 'deals'), 'and case is not a scope decision');
assert.ok(nameMatches('#deals-emea', 'deals-*'), 'a trailing star is a prefix');
assert.ok(!nameMatches('#deals', 'deals-*'), 'which does not match the bare stem');
assert.ok(!nameMatches('#hr-private', 'hr'), 'and nothing else is a pattern');

assert.ok(inScope('#deals', {}), 'no rules means everything given is read');
assert.ok(!inScope('#hr', { exclude: ['hr'] }), 'exclude drops it');
assert.ok(!inScope('#hr-comp', { exclude: ['hr-*'] }));
assert.ok(inScope('#deals', { only: ['deals', 'clients'] }), 'only is an allowlist');
assert.ok(!inScope('#random', { only: ['deals'] }), 'and everything else stops existing');
assert.ok(!inScope('#deals', { only: ['deals'], exclude: ['deals'] }),
  'exclude wins over only — the safe direction when the two disagree');

/* Excluding a channel and then reading a thread inside it would be an exclusion that
   does not exclude. */
var scoped = JSON.parse(JSON.stringify(input));
scoped.scope = { exclude: ['#halcyon'] };
scoped.threads = [{ channel: '#halcyon', root: at(2026, 8, 25, 11), text: [
  '=== THREAD PARENT MESSAGE ===',
  'From: Alex Rivera <' + ME + '> (U0EXAMPLE001)',
  'Message TS: ' + at(2026, 8, 25, 11),
  "I'll send the scope doc Wednesday."
].join('\n') }];

var narrowed = main([write(scoped), '--ledger', path.join(dir, 's1.json')]);
assert.strictEqual(narrowed.indexOf('#halcyon'), -1, 'an excluded channel contributes nothing');
assert.strictEqual(narrowed.indexOf('scope doc'), -1, 'not even through a thread inside it');
assert.ok(/left out of scope on purpose/.test(narrowed),
  'and the digest says it left something out deliberately, not by accident');

/* Out of scope and unread are different things and must read differently. */
assert.ok(!/were not read/.test(narrowed) || /out of scope/.test(narrowed),
  'a deliberate omission is not reported as a failure to read');

/* ------------------------------- the report ------------------------------- */
var rep = main(['--report', '--ledger', quietLedger]);
assert.ok(/Tracked \d+ items/.test(rep), 'reads the ledger with no input file at all');
assert.ok(/Recall: about \d+%/.test(rep), 'and reports recall once anything is spot-checked');
assert.ok(/By signal/.test(rep), 'broken out per detector, since one usually drags it down');

/* An unmeasured number must say so rather than print a flattering default. */
var freshRep = main(['--report', '--ledger', path.join(dir, 'never-run.json')]);
assert.ok(/Recall: unmeasured/.test(freshRep), 'nothing spot-checked means nothing claimed');
assert.ok(/Tracked 0 items/.test(freshRep), 'and an empty ledger does not throw');

/* ------------------------ the calendar, once there is one ------------------------ */

/* Two of the seven signals live in the gap between what was said and what is on the
   calendar. Without one they cannot fire — and "agreed but not booked" can never be
   settled either, so it over-reports every agreement forever. */
var cal = {
  self: ME, today: '2026-09-02', tzOffset: 0, principals: [],
  conversations: [{ channel: '#vector', members: ['lena@vectorfreight.com'], text:
    me(at(2026, 9, 1, 10), "Let's schedule a sync to walk through the renewal.") }]
};

var blind = main([write(cal), '--ledger', path.join(dir, 'c1.json')]);
assert.ok(/0 meetings/.test(blind), 'with no calendar it says so');
assert.ok(blind.indexOf('agenda') === -1, 'and a meeting with no agenda cannot be raised');

cal.events = { events: [{
  id: 'qbr', status: 'confirmed', summary: 'Vector Freight — Q3 QBR',
  start: { dateTime: '2026-09-03T14:00:00Z' },
  organizer: { email: ME },
  attendees: [{ email: ME }, { email: 'lena@vectorfreight.com' }]
}] };

var sighted = main([write(cal), '--ledger', path.join(dir, 'c2.json')]);
assert.ok(/and 1 meetings/.test(sighted), 'the calendar is read: ' +
  sighted.split('\n').filter(function (l) { return /^Read /.test(l); })[0]);
// The only item, so it is the one in FIRST — as the move rather than the signal's name.
assert.ok(/Send an agenda — |No agenda attached/.test(sighted), 'a meeting tomorrow with an outside guest fires');
assert.ok(/NEEDS TO GO OUT TODAY/.test(sighted),
  'and the brief says the agenda has to leave today, since one arriving on the morning'
  + ' of is too late to prep against');

/* The other direction, and the half a calendar-less run can never do: a promise to get
   something in the diary is kept by the thing being in the diary. Without a calendar it
   stays open forever, because nothing can ever settle it. */
var stillOpen = function (t) { return t.split('CLOSED ITSELF')[0]; };
assert.ok(stillOpen(blind).indexOf('walk through the renewal') > -1,
  'outstanding while there is no calendar to settle it against');
assert.ok(/CLOSED ITSELF[\s\S]*walk through the renewal/.test(sighted),
  'closed by the hold, not merely reclassified and left on the list');
assert.strictEqual(stillOpen(sighted).indexOf('walk through the renewal'), -1,
  'so it is off the open list entirely');

/* ------------- a second run the same day replaces the first ------------- */

/* The first real run (2026-09-14) read a thread wrong, was recorded, then run again
   corrected. The second digest said "0 new" — the bad run had spent every NEW flag — and
   listed as cleared an item still open. The run that counts for a date is the last. */
var partial = JSON.parse(JSON.stringify(input));
partial.conversations = partial.conversations.slice(1);
var onceLedger = path.join(dir, 'once.json'), twiceLedger = path.join(dir, 'twice.json');
var once = main([write(input), '--ledger', onceLedger]);
main([write(partial), '--ledger', twiceLedger]);
assert.strictEqual(main([write(input), '--ledger', twiceLedger]), once,
  'a corrected re-run reads exactly as if the bad run had never happened');
var nextDay = function (l) {
  var o = JSON.parse(JSON.stringify(input)); o.today = '2026-09-02';
  return main([write(o), '--ledger', l]);
};
assert.strictEqual(nextDay(twiceLedger), nextDay(onceLedger), 'and the next day builds on the run that counted');

/* ------------ a question held back for age is not a spot-check miss ------------ */
var young = { self: ME, today: '2026-09-01', tzOffset: 0, principals: [],
  conversations: [{ channel: '#ops', members: [], text: [
    them('Sam Park', 'sam@vectorfreight.com', 'U04', at(2026, 9, 1, 9), 'Can you review the Q4 headcount plan before Thursday?'),
    them('Sam Park', 'sam@vectorfreight.com', 'U04', at(2026, 9, 1, 10), 'Numbers came in a bit under forecast.')
  ].join('\n') }] };
var check = main([write(young), '--ledger', path.join(dir, 'young.json')]).split('SPOT CHECK')[1] || '';
assert.ok(/Numbers came in/.test(check), 'the spot check still samples what it found nothing in');
assert.strictEqual(check.indexOf('headcount'), -1,
  'but not a question it is only holding back until it is two days old');

/* ------------------------------ bad input ------------------------------ */
assert.throws(function () { main([write({ conversations: [] }), '--ledger', ledger]); },
  /Config is incomplete[\s\S]*"you"/,
  'without an address there is no way to tell inbound from outbound');


/* --- recall must measure the detector, not the age of the ledger ---
 *
 * `found` was the cumulative row count while `quiet` was one run's silent pool, so the
 * ratio drifted upward on its own. It is worst where retention outlives the read
 * window: the ledger keeps 90 days of rows while each run reads 21 days, so the
 * numerator grows for months while the denominator does not. A number that improves
 * because you kept using it is worse than no number.
 *
 * So the audit records what THIS read found, alongside how much of it was silent, and
 * the report uses that pair rather than the row count. */
var recLedger = path.join(dir, 'recall.json');
var recInput = JSON.parse(JSON.stringify(input));
main([write(recInput), '--ledger', recLedger]);
var recAudit = JSON.parse(fs.readFileSync(recLedger, 'utf8')).audit;
var recRows = JSON.parse(fs.readFileSync(recLedger, 'utf8')).rows.length;

assert.ok(recAudit.found > 0, 'the run records how many commitments it found');
assert.ok(recAudit.quiet > 0, 'and how many messages it found nothing in');
assert.ok(recAudit.found <= recRows,
  'found is this read, so it can never exceed the ledger — it is a different quantity');


/* --- coverage comes from connector evidence, not message dates ---
 *
 * The fetch takes a fixed number of newest messages, so a busy channel hands back three
 * days where three weeks were asked for. Everything older is absent, and absence is what
 * the ledger reads as CLEARED — a promise made a fortnight ago reported as done, by a
 * tool built to catch the thing nobody finished.
 *
 * The renderer has had an INCOMPLETE line for this since it was written. It was wired to
 * `capped: false`, a hardcoded constant, so on the Slack path it could never fire. */
var shortIn = {
  self: ME, today: '2026-09-25', tzOffset: 0, principals: [], lookbackDays: 21,
  conversations: [
    { channel: '#busy', members: [], text: [
      me(at(2026, 9, 24, 9), "I'll send the deck tomorrow."),
      me(at(2026, 9, 25, 9), "I'll book the room Friday.")
    ].join('\n') },
    { channel: '#quiet', members: [], text: [
      me(at(2026, 9, 1, 8), "I'll circle back with the forecast."),
      me(at(2026, 9, 24, 11), "I'll confirm the numbers Monday.")
    ].join('\n') }
  ],
  dm: { channel: 'D0', text: '' }
};
var shortText = main([write(shortIn), '--ledger', path.join(dir, 'short.json')]);
assert.ok(/INCOMPLETE — #busy: pagination evidence is missing/.test(shortText));
assert.ok(/INCOMPLETE — #quiet: pagination evidence is missing/.test(shortText),
  'message dates cannot prove either completeness or truncation');

/* --- what counts as having answered the spot check ---
 *
 * The sample is the only evidence about what the detector walked past, and it is
 * gathered by asking. Any reply used to count as an answer, so rejecting an item — or
 * typing a note to yourself, in the DM this tool posts to daily and invites replies in
 * — recorded the whole sample as reviewed and clean. With no misses the estimate is
 * found/(found+0), a flat 100%, so a fortnight of replying to anything at all reported
 * perfect recall on a spot check nobody had answered, and the honest "unmeasured"
 * state became unreachable after the first reply. */
var { marksFromDm } = require('../slack-run.js');
var ASKED = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'];
var stub = {
  seenReplies: function () { return []; },
  recallDigest: function () { return ['k1', 'k2', 'k3']; },
  audit: function () { return { asked: { '2026-09-03': ASKED }, checked: 0, missed: [] }; }
};
var answering = function (body) {
  var rows = [['k1', '2026-09-01', '2026-09-03', '', 'owed_by_us', 'a', 'x', ''],
              ['k2', '2026-09-01', '2026-09-03', '', 'owed_by_us', 'b', 'y', ''],
              ['k3', '2026-09-01', '2026-09-03', '', 'owed_by_us', 'c', 'z', '']];
  var r = marksFromDm([{ id: 'd1', body: 'OPEN LOOPS — for 2026-09-03\nthe digest' },
                       { id: 'r1', body: body }], stub, rows);
  return { checked: r.checked, misses: r.misses.length, marked: r.marked };
};
assert.strictEqual(answering('miss').checked, 8, 'a bare miss reviews the whole sample');
assert.strictEqual(answering('miss b').misses, 1, 'and a lettered one names a miss in it');
assert.strictEqual(answering('3').checked, 0, 'rejecting an item says nothing about the sample');
assert.strictEqual(answering('3').marked, 1, 'though the rejection itself still lands');
assert.strictEqual(answering('remember to call Dana').checked, 0,
  'and a note to yourself is not a spot check answer');

/* A digest without a reference: from before references, resolved by date as it always
   was — or, dated on or after the day this ledger started printing them, not this
   ledger's at all (another setup still on older code). */
var refStub = Object.assign({}, stub, {
  refsSince: function () { return '2026-09-03'; },
  recallRef: function (r) { return r === 'ab12' ? { date: '2026-09-03', keys: ['k1', 'k2', 'k3'], asked: [] } : null; }
});
var under = function (header) {
  var rows = [['k1', '2026-09-01', '2026-09-03', '', 'owed_by_us', 'a', 'x', '']];
  return marksFromDm([{ id: 'd1', body: header }, { id: 'r1', body: '1' }], refStub, rows);
};
assert.strictEqual(under('OPEN LOOPS — for 2026-09-02 · Wed').marked, 1, 'older and unreferenced: by date');
assert.strictEqual(under('OPEN LOOPS — for 2026-09-03 · Thu').marked, 0, 'unreferenced from the first referenced day: not ours');
assert.strictEqual(under('OPEN LOOPS — for 2026-09-03 · Thu').foreign.length, 1, 'and said so');
assert.strictEqual(under('```OPEN LOOPS — for 2026-09-03 · Thu · ref ab12').marked, 1, 'a known reference: its own list');
assert.strictEqual(under('OPEN LOOPS — for 2026-09-03 · Thu · ref cd34').marked, 0, 'an unknown one: nothing');

/* --- malformed input must not take the unattended run down ---
 *
 * A model writes input.json and a person writes the config, and both vary. Each of these
 * used to throw, so the evening run posted nothing at all — which reads exactly like a
 * quiet day. Found by a sweep of deliberately broken inputs; the rest of that sweep
 * (empty channels, emoji-only, 20,000-character messages, duplicates) already held. */
var cp = require('child_process');
var runner = path.join(__dirname, '..', 'slack-run.js');
var robustCfg = path.join(dir, 'robust.config.json');
fs.writeFileSync(robustCfg, JSON.stringify({ you: ME, selfDm: 'U0EXAMPLE001',
  ledger: path.join(dir, 'robust-ledger.json') }));
var line = function (ts, body) {
  return '=== Message from You <' + ME + '> (U0EXAMPLE001) at 2026-09-01 12:00:00 EDT ===\n' +
    (ts === null ? '' : 'Message TS: ' + ts + '\n') + body;
};
var fine = line('1788271200.000100', "I'll send the deck Friday.");
var runWith = function (label, input) {
  var f = path.join(dir, 'robust-' + label.replace(/\W+/g, '-') + '.json');
  fs.writeFileSync(f, JSON.stringify(Object.assign({ today: '2026-09-08' }, input)));
  return cp.spawnSync(process.execPath, [runner, f, '--config', robustCfg, '--dry'], { encoding: 'utf8' });
};
var survives = function (label, input) {
  var r = runWith(label, input);
  assert.strictEqual(r.status, 0, label + ' crashed the run: ' + (r.stderr || '').split('\n')[0]);
  return r.stdout;
};

assert.ok(/READ NOTHING/.test(survives('no timestamp line',
  { conversations: [{ channel: '#a', text: line(null, "I'll send it Friday.") }] })),
  'a format change that drops the timestamp line reaches READ NOTHING instead of crashing');
survives('timestamp is a dot', { conversations: [{ channel: '#a', text: line('.', "I'll send it.") }] });
assert.ok(/CALENDAR NOT READ/.test(survives('events is an error sentence',
  { conversations: [{ channel: '#a', text: fine }], events: 'Calendar unavailable' })),
  'a calendar that failed is run without, and said out loud');
survives('event with a non-date start', { conversations: [{ channel: '#a', text: fine }],
  events: { events: [{ id: 'x', summary: 'x', start: { dateTime: 'soon' }, attendees: [{ email: 'a@b.com' }] }] } });
survives('one member as a string', { conversations: [{ channel: '#a', members: 'lena@vf.com', text: fine }] });
survives('conversations as an object', { conversations: { channel: '#a', text: fine } });

// A zone name in tzOffset is a config mistake, so it stops the run — naming the setting.
var tz = runWith('tz zone name', { tzOffset: 'America/New_York', conversations: [{ channel: '#a', text: fine }] });
assert.notStrictEqual(tz.status, 0, 'a zone name is refused');
assert.ok(/tzOffset/.test(tz.stderr), 'with a message naming tzOffset, not "Invalid time value"');

/* --- relationship tiers come from the config ---
 *
 * They were read from the run's input alone, which nothing in the shipped setup ever
 * writes — so a tier set in the config was accepted, silently ignored, and the whole
 * feature was unreachable through normal use. Found on the first run with other people
 * in the workspace, which is the first time a tier could have applied at all. */
var tierCfg = path.join(dir, 'tier.config.json');
fs.writeFileSync(tierCfg, JSON.stringify({ you: ME, selfDm: 'U0EXAMPLE001',
  ledger: path.join(dir, 'tier-ledger.json'),
  contacts: { 'vectorfreight.com': { tier: 'key_account', label: 'Vector Freight' } } }));
var fromLena = '=== Message from Lena <lena@vectorfreight.com> (U0EXAMPLE009) at 2026-09-01 12:00:00 EDT === \n' +
  'Message TS: 1788271200.000100\n' + "I'll get you the signed MSA back by Tuesday.";
var tierIn = path.join(dir, 'tier-input.json');
var tierRun = function (extra) {
  fs.writeFileSync(tierIn, JSON.stringify(Object.assign({ today: '2026-09-08',
    conversations: [{ channel: '#deals', text: fromLena }] }, extra || {})));
  return cp.spawnSync(process.execPath, [runner, tierIn, '--config', tierCfg, '--dry'], { encoding: 'utf8' }).stdout;
};
assert.ok(/Vector Freight/.test(tierRun()), 'a tier written in the config reaches the digest');
assert.ok(/Anchor client/.test(tierRun({ contacts: { 'vectorfreight.com': { tier: 'key_account', label: 'Anchor client' } } })),
  'and a run can still override an entry for a one-off');

fs.rmSync(dir, { recursive: true, force: true });
console.log('slack-run: OK');
