/* The Slack adapter parses display text rather than structured fields, so the
 * things most likely to break it are format details: a missing email, a name with
 * spaces, markup in the body, Slack's own housekeeping notices.
 *
 * The header format below is copied from a real connector response. The thread and
 * attachment markers are NOT — no thread existed in the workspace to observe, so
 * those are matched loosely and their absence is the safe case. */
var assert = require('assert');
var { parseChannel, cleanText, stamp } = require('../src/slack.js');

var OPTS = { channel: '#deals', members: ['lena@vectorfreight.com'], tzOffset: 0 };

/* --- the shape the connector actually returned --- */
var real = [
  'Channel: #general (C0EXAMPLE001)',
  '',
  '=== Message from Alex Rivera <you@example.com> (U0EXAMPLE001) at 2026-09-01 11:06:12 EDT === ',
  'Message TS: 1788275172.381139',
  "I'll send the pricing sheet Thursday."
].join('\n');

var m = parseChannel(real, OPTS);
assert.strictEqual(m.length, 1, 'one message parsed');
assert.strictEqual(m[0].from, 'you@example.com', 'the inline email becomes the sender');
assert.strictEqual(m[0].id, '1788275172.381139');
assert.strictEqual(m[0].body, "I'll send the pricing sheet Thursday.");
assert.strictEqual(m[0].subject, '#deals', 'the conversation name stands in for a subject');
assert.deepStrictEqual(m[0].to, ['lena@vectorfreight.com']);
assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(m[0].date), 'date is the shape loops.js wants');
assert.strictEqual(m[0].date.slice(0, 10), '2026-09-01', 'and comes from the epoch, not the EDT string');

/* --- several messages, and the ones that are not really messages --- */
var many = [
  '=== Message from Alex Rivera <you@example.com> (U0EXAMPLE001) at 2026-09-01 09:00:00 EDT ===',
  'Message TS: 1788260400.000100',
  '<@U0EXAMPLE001|Alex Rivera> has joined the channel',
  '=== Message from Lena Borg <lena@vectorfreight.com> (U0EXAMPLE002) at 2026-09-01 10:00:00 EDT ===',
  'Message TS: 1788264000.000200',
  "We'll get you the countersigned copy Monday.",
  '=== Message from Alex Rivera <you@example.com> (U0EXAMPLE001) at 2026-09-01 11:00:00 EDT ===',
  'Message TS: 1788267600.000300',
  'Thanks — noted.'
].join('\n');

var mm = parseChannel(many, OPTS);
assert.strictEqual(mm.length, 2, 'the join notice is not a message anyone promised anything in');
assert.strictEqual(mm[0].from, 'lena@vectorfreight.com');
assert.ok(mm[0].date < mm[1].date, 'messages come back oldest first, as the detector expects');

/* --- a sender with no email on the header --- */
var anon = [
  '=== Message from Someone (U0EXAMPLE003) at 2026-09-01 12:00:00 EDT ===',
  'Message TS: 1788271200.000400',
  "I'll book the room."
].join('\n');
var a = parseChannel(anon, OPTS);
assert.strictEqual(a.length, 1, 'a missing email must not drop the message');
assert.strictEqual(a[0].from, 'U0EXAMPLE003@slack.local',
  'it falls back to something addressable, so direction still resolves');

/* --- what the connector adds, observed on a live workspace --- */

/* Every message sent through an app carries this footer. Left in the body it puts
   the same words in every message, so every message shares subject matter with
   every other one and closure matching starts agreeing with everything. */
var footed = parseChannel([
  '=== Message from Alex Rivera <you@example.com> (U0EXAMPLE001) at 2026-09-01 16:02:38 EDT ===',
  'Message TS: 1788292958.058409',
  "I'll send the revised pricing sheet to Meridian by Thursday.",
  '*Sent using* <@U0EXAMPLE009|Claude>'
].join('\n'), OPTS);
assert.strictEqual(footed[0].body, "I'll send the revised pricing sheet to Meridian by Thursday.",
  'the app footer is not part of what anyone said');

/* A thread root is announced with a count, not an id — and the replies themselves
   are not in a channel read at all, so fetching them is a separate call. */
var rooted = parseChannel([
  '=== Message from Alex Rivera <you@example.com> (U0EXAMPLE001) at 2026-09-01 16:03:11 EDT ===',
  'Message TS: 1788292991.482509',
  'Halcyon pilot — scoping thread.',
  '*Sent using* <@U0EXAMPLE009|Claude>',
  'Thread: 1 replies (latest: 2026-09-01 16:03:17 EDT)'
].join('\n'), OPTS);
assert.strictEqual(rooted[0].body, 'Halcyon pilot — scoping thread.', 'the thread note is not content');
assert.strictEqual(rooted[0].hasThread, true, 'but it is recorded, so replies can be fetched');
assert.strictEqual(footed[0].hasThread, false);

/* The connector returns newest first, and chat puts many messages inside one minute.
   Sorting on the minute-truncated date leaves them scrambled — and a promise that
   lands after its own delivery can never be closed by it. */
var sameMinute = [3, 1, 2].map(function (n) {
  return ['=== Message from Alex Rivera <you@example.com> (U0EXAMPLE001) at 2026-09-01 16:02:0' + n + ' EDT ===',
          'Message TS: 178829295' + n + '.00000' + n, 'message ' + n].join('\n');
}).join('\n');
var ordered = parseChannel(sameMinute, OPTS);
assert.deepStrictEqual(ordered.map(function (m) { return m.body; }),
  ['message 1', 'message 2', 'message 3'], 'ordered on the epoch, not the truncated date');
assert.strictEqual(ordered[0].date, ordered[2].date, 'even though all three share a minute');

/* --- a thread read, which uses a different format entirely ---
 *
 * Copied from a live response. The banner and the identity are separate lines here,
 * where a channel read puts them together — so the adapter has to know both shapes,
 * and a thread read is the only way to see a reply at all. */
var threadText = [
  '=== THREAD PARENT MESSAGE ===',
  'From: Alex Rivera <you@example.com> (U0EXAMPLE001)',
  'Time: 2026-09-01 16:03:11 EDT',
  'Message TS: 1788292991.482509',
  'Halcyon pilot — scoping thread.',
  '*Sent using* <@U0EXAMPLE009|Claude>',
  '',
  '=== THREAD REPLIES (1 total) ===',
  '',
  '--- Reply 1 of 1 ---',
  'From: Lena Borg <lena@vectorfreight.com> (U0EXAMPLE002)',
  'Time: 2026-09-01 16:03:17 EDT',
  'Message TS: 1788292997.287589',
  "I'll put together the scope doc and share it Wednesday.",
  '*Sent using* <@U0EXAMPLE009|Claude>'
].join('\n');

var th = parseChannel(threadText, { channel: '#deals', threadId: '1788292991.482509', tzOffset: 0 });
assert.strictEqual(th.length, 2, 'parent and reply both parse');
assert.strictEqual(th[0].body, 'Halcyon pilot — scoping thread.');
assert.strictEqual(th[1].body, "I'll put together the scope doc and share it Wednesday.");
assert.strictEqual(th[1].from, 'lena@vectorfreight.com', 'identity comes off the From: line');
assert.ok(th.every(function (m) { return m.threadId === '1788292991.482509'; }),
  'a thread is its own boundary — the tightest one Slack offers');

/* The section banner is a heading, not a message, and must not become an empty one. */
assert.ok(th.every(function (m) { return m.body.indexOf('THREAD REPLIES') === -1; }));

/* A body line that happens to start "From:" must not rewrite who sent the message. */
var quoted = parseChannel([
  '=== THREAD PARENT MESSAGE ===',
  'From: Alex Rivera <you@example.com> (U0EXAMPLE001)',
  'Message TS: 1788292958.058409',
  'Forwarding this on:',
  'From: Someone Else <other@example.com> (U0EXAMPLE007)',
  "I'll handle it."
].join('\n'), OPTS);
assert.strictEqual(quoted[0].from, 'you@example.com', 'the first identity wins');

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
var { detectLoops } = require('../src/loops.js');
var epoch = function (y, mo, d, h) { return (Date.UTC(y, mo - 1, d, h) / 1000).toFixed(6); };

var convo = [
  '=== Message from Lena Borg <lena@vectorfreight.com> (U0EXAMPLE002) at 2026-08-01 10:00:00 UTC ===',
  'Message TS: ' + epoch(2026, 8, 1, 10),
  "We'll get the contract back to you Friday Aug 8.",
  '=== Message from Alex Rivera <you@example.com> (U0EXAMPLE001) at 2026-08-04 10:00:00 UTC ===',
  'Message TS: ' + epoch(2026, 8, 4, 10),
  'Great — thanks Lena.'
].join('\n');

var msgs = parseChannel(convo, { channel: '#vector-freight', members: ['lena@vectorfreight.com'], tzOffset: 0 });
assert.strictEqual(msgs[0].date, '2026-08-01T10:00', 'the epoch round-trips to the right day');

var r = detectLoops(msgs, [], { exec: 'you@example.com', today: '2026-08-12' });
var owed = r.open.filter(function (l) { return l.type === 'owed_to_us'; })[0];
assert.ok(owed, 'an inbound promise in Slack is found the same way it is in mail');
assert.strictEqual(owed.due, '2026-08-08', 'and its deadline resolves from the message date');
assert.strictEqual(owed.status, 'overdue');
assert.strictEqual(owed.who, 'lena@vectorfreight.com');

/* A promise to send a signed document used to vanish: DELIVER matches the bare word
   "signed", so the sentence was read as the document already having been sent. Tense
   decides, not vocabulary — "we'll have it back to you Friday" is future whatever
   nouns it contains. The fixture escaped it only because "countersigned" has no word
   boundary before "signed", which is luck rather than coverage. */
var signed = parseChannel([
  '=== Message from Lena Borg <lena@vectorfreight.com> (U0EXAMPLE002) at 2026-08-01 10:00:00 UTC ===',
  'Message TS: ' + epoch(2026, 8, 1, 10),
  "We'll have the signed order form back to you Friday Aug 8."
].join('\n'), { channel: '#vf', members: [], tzOffset: 0 });
var kept = detectLoops(signed, [], { exec: 'you@example.com', today: '2026-08-12' });
assert.strictEqual(kept.open.length, 1, 'a promise about a signed document survives');
assert.strictEqual(kept.open[0].type, 'owed_to_us');
assert.strictEqual(kept.open[0].due, '2026-08-08', 'with its deadline intact');

console.log('slack: OK');
