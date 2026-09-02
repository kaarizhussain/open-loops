/* The corpus adapter, against the three things that were actually wrong with it.
 *
 * All three were found by running it and reading the output, not by review — the
 * benchmark's own sample printed items ending in a bare "=" and a mailbox owner who
 * was not the person whose mailbox it was. The fixture below is synthetic, so this
 * runs in CI without the 443MB download, but every habit it exercises was copied from
 * a real message in the corpus. */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var E = require('../tools/enron.js');

var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enron-'));
var write = function (folder, name, text) {
  var d = path.join(dir, folder);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, name), text.replace(/\n/g, '\r\n'));   // the corpus is CRLF
};

/* Quoted-printable, a folded recipient list, and an inline quoted reply — all three
   in one message, because that combination is entirely ordinary here. */
write('sent', '1.', [
  'Message-ID: <1.JavaMail.evans@thyme>',
  'Date: Fri, 8 Mar 2002 08:58:39 -0800 (PST)',
  'From: robert.badeer@enron.com',
  "To: 'first@enron.com, second@counterparty.com,",
  '\tthird@counterparty.com',
  'Subject: RE: Re: Rollout plan',
  'Content-Transfer-Encoding: quoted-printable',
  'X-Folder: \\Robert_Badeer_Mar2002_1\\Badeer, Robert\\Sent Items',
  '',
  "I'll send the revised numbers over on Thursday, and I will book a call =",
  'for the week after.',
  '',
  '-----Original Message-----',
  'From: Someone Else',
  'Sent: Thursday, March 07, 2002 9:25 AM',
  '',
  "I'll have the whole thing finished by Monday.",
  ''
].join('\n'));

var msgs = E.mailbox(dir);
assert.strictEqual(msgs.length, 1);
var m = msgs[0];

/* A soft line break is a break in the ENCODING, not in the text. Left encoded, the
   sentence splitter sees two fragments and the detector reports half a clause. */
assert.ok(m.body.indexOf('I will book a call for the week after.') > -1,
  'quoted-printable soft breaks must be joined, not left as "=" at end of line: ' + JSON.stringify(m.body));
assert.strictEqual(/=\n/.test(m.body), false, 'and no soft break survives');

/* The reply underneath is somebody else's promise. Read as ours, every promise the
   other party ever made is re-detected on every reply in the thread. */
assert.strictEqual(m.body.indexOf('finished by Monday'), -1,
  'the quoted reply is not our words and must be cut');

/* Recipients continue onto folded lines. Parsing only the first loses everyone after
   it — and `to` is the only evidence no_followup has. */
assert.deepStrictEqual(m.to,
  ['first@enron.com', 'second@counterparty.com', 'third@counterparty.com'],
  'a folded To: header carries all of its addresses, and the stray quote is dropped');

assert.strictEqual(m.date, '2002-03-08T08:58', 'local wall clock, as every adapter here reports');
assert.strictEqual(m.threadId, 'rollout plan', 'stacked RE:/Re: prefixes are one conversation');
assert.strictEqual(/\r/.test(m.threadId), false, 'and no CR survives into the key');

/* Whose mailbox this is. Taking the commonest sender overall picks whoever mailed
   them most, which in a delegated mailbox is somebody else — and that inverts every
   direction call, turning their promises into yours. */
write('inbox', '2.', [
  'Message-ID: <2.JavaMail.evans@thyme>',
  'Date: Fri, 8 Mar 2002 09:10:00 -0800 (PST)',
  'From: prolific.correspondent@enron.com',
  'To: robert.badeer@enron.com',
  'Subject: One of many',
  'X-Folder: \\Robert_Badeer_Mar2002_1\\Badeer, Robert\\Inbox',
  '',
  'Just checking in on that.',
  ''
].join('\n'));
write('inbox', '3.', [
  'Message-ID: <3.JavaMail.evans@thyme>',
  'Date: Fri, 8 Mar 2002 09:11:00 -0800 (PST)',
  'From: prolific.correspondent@enron.com',
  'To: robert.badeer@enron.com',
  'Subject: Another',
  'X-Folder: \\Robert_Badeer_Mar2002_1\\Badeer, Robert\\Inbox',
  '',
  'And again.',
  ''
].join('\n'));

var box = E.mailbox(dir);
assert.strictEqual(box.length, 3);
assert.strictEqual(E.owner(box), 'robert.badeer@enron.com',
  'the owner comes from their Sent folder, not from whoever wrote to them most');

fs.rmSync(dir, { recursive: true, force: true });
console.log('enron: OK');
