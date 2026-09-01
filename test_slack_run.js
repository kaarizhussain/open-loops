/* The Slack runner, end to end: connector text in, digest out, corrections back.
 *
 * The workspace this was written against is empty, so the conversations below are
 * invented — the same standard the demo fixture is held to. They exist to exercise
 * the pipeline, not to prove anything about accuracy on real chatter. */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var { main } = require('./slack-run.js');

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
assert.ok(/are overdue|is overdue/.test(text), 'the headline names the overdue work');

/* Promises in both directions, found in Slack exactly as they are in mail. */
assert.ok(text.indexOf("We'll get the revised contract back to you Friday Aug 28.") > -1,
  'an inbound promise from a counterparty');
assert.ok(text.indexOf("I'll put together a scope doc and send it Wednesday.") > -1,
  'and an outbound one of your own');
assert.ok(text.indexOf('#vector-freight') > -1, 'the channel name stands in for a subject');

/* Numbered, because a reply quotes the number back. */
var numbered = text.split('\n').filter(function (l) { return /^\s*\d+\. \[/.test(l); });
assert.ok(numbered.length >= 3, 'every open item is numbered, got ' + numbered.length);
numbered.forEach(function (line, i) {
  assert.strictEqual(parseInt(line, 10), i + 1, 'numbering is contiguous: ' + line);
});
assert.ok(/· \d+ new/.test(text), 'a cold ledger reports everything as new');

/* --------------- second run: the same conversations are not news --------------- */
var again = main([write(input), '--ledger', ledger]);
assert.ok(/· 0 new/.test(again), 'nothing is new the second time');
assert.ok(again.indexOf('NEW · ') === -1, 'and no item is still flagged new');

/* ------------- a correction, typed into the DM under the digest ------------- */
var firstItem = numbered[0].replace(/^\s*\d+\.\s*\[[^\]]*\]\s*/, '');
input.dm.text = [
  me(at(2026, 9, 1, 18), '```\n' + text + '\n```'),   // the digest, as it was posted
  me(at(2026, 9, 1, 19), '1')                          // "number 1 is not real"
].join('\n');

var third = main([write(input), '--ledger', ledger]);
assert.ok(/Took your last reply — 1 item marked wrong/.test(third),
  'the correction is acknowledged: ' + third.split('\n').slice(4, 8).join(' | '));
assert.strictEqual(third.indexOf(firstItem), -1, 'and that item is gone: ' + firstItem);
assert.ok(/1 hidden as wrong/.test(third), 'the count says something is being hidden');

/* The same reply must not be re-read. It stays in the DM forever, and re-applying it
   against a now-shorter list would mark a different item every single run. */
var fourth = main([write(input), '--ledger', ledger]);
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

/* Supporting one person keeps the split and names them. */
var named = JSON.parse(JSON.stringify(input));
named.principals = [{ label: 'Dana' }];
var namedText = main([write(named), '--ledger', path.join(dir, 'named.json')]);
assert.ok(namedText.indexOf('NEEDS DANA') > -1, 'the pile is named after the person: ' +
  namedText.split('\n').filter(function (l) { return /\(\d+\) —/.test(l); }).join(' | '));
assert.strictEqual(namedText.indexOf('NEEDS THE EXECUTIVE'), -1, 'and not after a job title');

/* Supporting several puts the name on each item, since one heading cannot carry two. */
var multi = JSON.parse(JSON.stringify(input));
multi.principals = [
  { label: 'Dana', address: 'sana@halcyon.io' },
  { label: 'Marcus', address: 'rachel@northstar.io' }
];
var multiText = main([write(multi), '--ledger', path.join(dir, 'multi.json')]);
assert.ok(/for (Dana|Marcus) · /.test(multiText),
  'each item says whose it is when the heading cannot');

/* ------------------------------ bad input ------------------------------ */
assert.throws(function () { main([write({ conversations: [] }), '--ledger', ledger]); },
  /needs "self"/, 'without an address there is no way to tell inbound from outbound');

fs.rmSync(dir, { recursive: true, force: true });
console.log('slack-run: OK');
