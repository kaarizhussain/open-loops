/* Runs the real Code.gs in a sandbox with the Google globals stubbed, so the
 * digest rendering is verified rather than assumed. Apps Script cannot be run
 * here; everything except the two API reads can. */
var assert = require('assert');
var fs = require('fs');
var vm = require('vm');
var path = require('path');

var F = require('../src/fixture.js');
var here = function (f) { return fs.readFileSync(path.join(__dirname, f), 'utf8'); };
var up = function (f) { return fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'); };

var TZ = 'America/New_York';
var sandbox = {
  console: console,
  Logger: { log: function () {} },
  Session: { getScriptTimeZone: function () { return TZ; } },
  Utilities: {
    formatDate: function (d, tz, fmt) {
      var iso = new Date(d).toISOString();
      return fmt.indexOf('HH:mm') > -1 ? iso.slice(0, 16) : iso.slice(0, 10);
    }
  },
  MailApp: { sendEmail: function (o) { sandbox.__sent = o; } },
  module: undefined
};
vm.createContext(sandbox);
[up('loops.js'), here('adapters.js'), here('Code.gs')].forEach(function (src) {
  vm.runInContext(src, sandbox);
});

/* Point CONFIG at the demo executive and feed it the fixture. */
sandbox.CONFIG.exec = F.EXEC;
sandbox.CONFIG.contacts = F.RELATIONSHIPS;
var opts = { exec: F.EXEC, today: F.TODAY, contacts: F.RELATIONSHIPS };
var result = sandbox.detectLoops(F.MESSAGES, F.EVENTS, opts);
var briefs = sandbox.meetingBriefs(F.MESSAGES, F.EVENTS, result.open, opts);

/* today() reads the clock, so pin it to the fixture's date for a stable render */
sandbox.today = function () { return F.TODAY; };

var text = sandbox.render({
  messages: F.MESSAGES, events: F.EVENTS, result: result, briefs: briefs
});

/* --- the digest says the right things --- */
assert.ok(text.indexOf('OPEN LOOPS — for ' + F.TODAY) === 0, 'starts with the date it is for');
assert.ok(text.indexOf('Read 25 messages and 5 meetings.') > -1, 'reports what it read');

assert.ok(text.indexOf('NEEDS TO GO OUT TODAY') > -1, 'the agenda due today is surfaced first');
assert.ok(text.indexOf('Vector Freight — Q3 QBR') > -1, 'the QBR agenda is in it');
assert.ok(text.indexOf('[LATE]') > -1, 'the Larkspur agenda window has already passed');

['NEEDS THE EXECUTIVE', 'CHASE THEM', 'YOURS TO HANDLE'].forEach(function (h) {
  assert.ok(text.indexOf(h) > -1, 'missing section: ' + h);
});
assert.ok(text.indexOf('NEEDS THE EXECUTIVE') < text.indexOf('YOURS TO HANDLE'),
  'the short list only she can do comes before the long list you can absorb');

assert.ok(text.indexOf('6d late') > -1, 'overdue items show how late they are');
assert.ok(text.indexOf('Key account') > -1, 'relationship tiers travel into the digest');
assert.ok(text.indexOf('is a weekend — last working day is 2026-08-07') > -1,
  'the Saturday deadline is explained');
assert.ok(text.indexOf('CLOSED ITSELF (3)') > -1, 'self-cleared items are reported');
assert.ok(/Drafts only/.test(text), 'the digest says plainly that nothing was sent');

/* --- sending --- */
sandbox.build = function () { return { messages: F.MESSAGES, events: F.EVENTS, result: result, briefs: briefs }; };
sandbox.run();
var sent = sandbox.__sent;
assert.strictEqual(sent.to, sandbox.CONFIG.sendTo);
assert.ok(/^Open loops — 2026-08-06 \(15 open, 4 overdue\)$/.test(sent.subject),
  'subject carries the counts: ' + sent.subject);
assert.strictEqual(sent.body, text);
assert.ok(!/html/i.test(Object.keys(sent).join(' ')), 'plain text only — nothing to render or break');

console.log(text);
console.log('\nrender: OK');
