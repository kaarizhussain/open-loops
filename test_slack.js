/* The Slack adapter parses display text rather than structured fields, so the
 * things most likely to break it are format details: a missing email, a name with
 * spaces, markup in the body, Slack's own housekeeping notices.
 *
 * The header format below is copied from a real connector response. The thread and
 * attachment markers are NOT — no thread existed in the workspace to observe, so
 * those are matched loosely and their absence is the safe case. */
var assert = require('assert');
var { parseChannel, cleanText, stamp } = require('./src/slack.js');

var OPTS = { channel: '#deals', members: ['lena@vectorfreight.com'], tzOffset: 0 };

/* --- the shape the connector actually returned --- */
var real = [
  'Channel: #all-open-loops (C0BV0PRC95E)',
  '',
  '=== Message from Kaariz Hussain <kaarizh@gmail.com> (U0BU26UAZD3) at 2026-09-01 11:06:12 EDT === ',
  'Message TS: 1788275172.381139',
  "I'll send the pricing sheet Thursday."
].join('\n');

var m = parseChannel(real, OPTS);
assert.strictEqual(m.length, 1, 'one message parsed');
assert.strictEqual(m[0].from, 'kaarizh@gmail.com', 'the inline email becomes the sender');
assert.strictEqual(m[0].id, '1788275172.381139');
assert.strictEqual(m[0].body, "I'll send the pricing sheet Thursday.");
assert.strictEqual(m[0].subject, '#deals', 'the conversation name stands in for a subject');
assert.deepStrictEqual(m[0].to, ['lena@vectorfreight.com']);
assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(m[0].date), 'date is the shape loops.js wants');
assert.strictEqual(m[0].date.slice(0, 10), '2026-09-01', 'and comes from the epoch, not the EDT string');

/* --- several messages, and the ones that are not really messages --- */
var many = [
  '=== Message from Kaariz Hussain <kaarizh@gmail.com> (U0BU26UAZD3) at 2026-09-01 09:00:00 EDT ===',
  'Message TS: 1788260400.000100',
  '<@U0BU26UAZD3|Kaariz Hussain> has joined the channel',
  '=== Message from Lena Borg <lena@vectorfreight.com> (U0BU111AAA1) at 2026-09-01 10:00:00 EDT ===',
  'Message TS: 1788264000.000200',
  "We'll get you the countersigned copy Monday.",
  '=== Message from Kaariz Hussain <kaarizh@gmail.com> (U0BU26UAZD3) at 2026-09-01 11:00:00 EDT ===',
  'Message TS: 1788267600.000300',
  'Thanks — noted.'
].join('\n');

var mm = parseChannel(many, OPTS);
assert.strictEqual(mm.length, 2, 'the join notice is not a message anyone promised anything in');
assert.strictEqual(mm[0].from, 'lena@vectorfreight.com');
assert.ok(mm[0].date < mm[1].date, 'messages come back oldest first, as the detector expects');

/* --- a sender with no email on the header --- */
var anon = [
  '=== Message from Someone (U0BU999ZZZ9) at 2026-09-01 12:00:00 EDT ===',
  'Message TS: 1788271200.000400',
  "I'll book the room."
].join('\n');
var a = parseChannel(anon, OPTS);
assert.strictEqual(a.length, 1, 'a missing email must not drop the message');
assert.strictEqual(a[0].from, 'U0BU999ZZZ9@slack.local',
  'it falls back to something addressable, so direction still resolves');

/* --- Slack markup would otherwise reach the detector as content --- */
assert.strictEqual(cleanText('<@U123|Dana> can you look?'), '@Dana can you look?');
assert.strictEqual(cleanText('ping <@U123> please'), 'ping  please');
assert.strictEqual(cleanText('see <#C123|deals>'), 'see #deals');
assert.strictEqual(cleanText('<https://x.com/doc|the contract> is up'), 'the contract is up');
assert.strictEqual(cleanText('<https://x.com/doc>'), 'https://x.com/doc');
assert.strictEqual(cleanText('Ben &amp; Co &lt;fine&gt;'), 'Ben & Co <fine>');

/* A bare URL left in place contributes false subject-matter words to closure
   matching, which is how an unrelated delivery starts closing real promises. */
assert.strictEqual(cleanText('sent <https://acme.com/pricing-sheet-final|it>'), 'sent it');

/* --- the whole point: it feeds the detector unchanged --- */
var { detectLoops } = require('./src/loops.js');
var epoch = function (y, mo, d, h) { return (Date.UTC(y, mo - 1, d, h) / 1000).toFixed(6); };

var convo = [
  '=== Message from Lena Borg <lena@vectorfreight.com> (U0BU111AAA1) at 2026-08-01 10:00:00 UTC ===',
  'Message TS: ' + epoch(2026, 8, 1, 10),
  "We'll get the contract back to you Friday Aug 8.",
  '=== Message from Kaariz Hussain <kaarizh@gmail.com> (U0BU26UAZD3) at 2026-08-04 10:00:00 UTC ===',
  'Message TS: ' + epoch(2026, 8, 4, 10),
  'Great — thanks Lena.'
].join('\n');

var msgs = parseChannel(convo, { channel: '#vector-freight', members: ['lena@vectorfreight.com'], tzOffset: 0 });
assert.strictEqual(msgs[0].date, '2026-08-01T10:00', 'the epoch round-trips to the right day');

var r = detectLoops(msgs, [], { exec: 'kaarizh@gmail.com', today: '2026-08-12' });
var owed = r.open.filter(function (l) { return l.type === 'owed_to_us'; })[0];
assert.ok(owed, 'an inbound promise in Slack is found the same way it is in mail');
assert.strictEqual(owed.due, '2026-08-08', 'and its deadline resolves from the message date');
assert.strictEqual(owed.status, 'overdue');
assert.strictEqual(owed.who, 'lena@vectorfreight.com');

/* Found while writing the line above, and left as a note rather than a fix because
   loops.js is being edited elsewhere: DELIVER matches the bare word "signed", so
   "we'll have the signed order form back to you Friday" is read as a delivery and
   the promise is dropped. Any promise to send a signed document disappears. The
   fixture only escapes it because "countersigned" has no word boundary before
   "signed". Same class of bug as the three the README already documents. */
var trap = parseChannel([
  '=== Message from Lena Borg <lena@vectorfreight.com> (U0BU111AAA1) at 2026-08-01 10:00:00 UTC ===',
  'Message TS: ' + epoch(2026, 8, 1, 10),
  "We'll have the signed order form back to you Friday Aug 8."
].join('\n'), { channel: '#vf', members: [], tzOffset: 0 });
var missed = detectLoops(trap, [], { exec: 'kaarizh@gmail.com', today: '2026-08-12' });
assert.strictEqual(missed.open.length, 0,
  'KNOWN BUG: a promise containing "signed" is swallowed by DELIVER — see note above');

console.log('slack: OK');
