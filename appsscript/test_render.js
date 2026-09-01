/* Runs the real Code.gs in a sandbox with the Google globals stubbed, so the
 * digest rendering is verified rather than assumed. Apps Script cannot be run
 * here; everything except the two API reads can — and those are stubbed with the
 * fixture, so build() and the ledger it writes are exercised for real. */
var assert = require('assert');
var fs = require('fs');
var vm = require('vm');
var path = require('path');

var F = require('../src/fixture.js');
var here = function (f) { return fs.readFileSync(path.join(__dirname, f), 'utf8'); };
var up = function (f) { return fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'); };

/* A Sheet that lives in an array. Enough of the API for the ledger to round-trip. */
function fakeSheet() {
  var data = [];
  return {
    __data: data,
    getLastRow: function () { return data.length; },
    appendRow: function (r) { data.push(r.slice()); },
    setFrozenRows: function () {},
    getRange: function (row, col, nr, nc) {
      return {
        getValues: function () {
          var out = [];
          for (var i = 0; i < nr; i++) {
            var src = data[row - 1 + i] || [], line = [];
            for (var j = 0; j < nc; j++) line.push(src[col - 1 + j] == null ? '' : src[col - 1 + j]);
            out.push(line);
          }
          return out;
        },
        setValues: function (vals) {
          vals.forEach(function (line, i) {
            var t = data[row - 1 + i] || (data[row - 1 + i] = []);
            line.forEach(function (v, j) { t[col - 1 + j] = v; });
          });
        }
      };
    }
  };
}

var SHEET = fakeSheet();
var LEDGER_URL = 'https://sheets.example/open-loops-ledger';
var SS = {
  getId: function () { return 'ledger-id'; },
  getUrl: function () { return LEDGER_URL; },
  getSheets: function () { return [SHEET]; }
};
SHEET.getParent = function () { return SS; };

var props = {};

/* Replies to past digests, as GmailApp would hand them over. The test drives this. */
var REPLIES = [];
function fakeGmail() {
  return {
    search: function () {
      return REPLIES.map(function (r) {
        return { getMessages: function () {
          return [
            { getSubject: function () { return r.subject; },
              getFrom: function () { return 'Open Loops <sender@northstar.io>'; },
              getPlainBody: function () { return ''; } },
            { getSubject: function () { return 'Re: ' + r.subject; },
              getFrom: function () { return r.from; },
              getId: function () { return r.id || ('reply|' + r.subject + '|' + r.body); },
              getPlainBody: function () { return r.body; } }
          ];
        } };
      });
    }
  };
}

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
  GmailApp: fakeGmail(),
  PropertiesService: {
    getScriptProperties: function () {
      return {
        getProperty: function (k) { return props[k] || null; },
        setProperty: function (k, v) { props[k] = v; }
      };
    }
  },
  SpreadsheetApp: {
    create: function () { return SS; },
    openById: function (id) { if (id === 'ledger-id') return SS; throw new Error('no such sheet'); }
  },
  module: undefined
};
vm.createContext(sandbox);
[up('loops.js'), here('adapters.js'), here('ledger.js'), here('Code.gs')].forEach(function (src) {
  vm.runInContext(src, sandbox);
});

/* Point CONFIG at the demo executive and feed build() the fixture instead of Gmail. */
sandbox.CONFIG.exec = F.EXEC;
sandbox.CONFIG.contacts = F.RELATIONSHIPS;
var MESSAGES = F.MESSAGES;
sandbox.readMessages = function () { return MESSAGES; };
sandbox.readEvents = function () { return F.EVENTS; };
sandbox.today = function () { return F.TODAY; };   // the clock, pinned

/* ======================= run one: everything is new ======================= */
var b1 = sandbox.build(true);
var text = sandbox.render(b1);

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

/* --- the ledger, first time out --- */
assert.strictEqual(b1.ledger.fresh, 15, 'on a cold ledger every open loop is new');
assert.ok(text.indexOf('15 open · 15 new') > -1, 'the first line says what changed: ' + text.split('\n')[2]);
assert.ok(text.indexOf('NEW · ') > -1, 'and each item is marked new');
assert.ok(text.indexOf(LEDGER_URL) > -1, 'the digest links the sheet you correct it in');
assert.strictEqual(SHEET.__data.length, 16, 'header plus one row per loop');
assert.deepStrictEqual(SHEET.__data[0], sandbox.LEDGER_COLS, 'the sheet is labelled');

/* ================= run two: same mail, so nothing is new ================= */
var b2 = sandbox.build(true);
var text2 = sandbox.render(b2);
assert.strictEqual(b2.ledger.fresh, 0, 'the same list twice is not fifteen new things');
assert.ok(text2.indexOf('15 open · 0 new') > -1, 'and the digest leads with that');
assert.ok(text2.indexOf('NEW · ') === -1, 'nothing is still flagged new');
assert.strictEqual(SHEET.__data.length, 16, 'and no rows were duplicated');

/* ============ run three: one marked wrong, and it stays gone ============ */
var COL = sandbox.COL;
/* Not the t3 promise, which run four needs alive in order to clear it — and not one
 * of the three meetings whose text is identically 'No agenda attached', or checking
 * that it vanished from the digest would only be checking that text is unique. */
var seen = {};
SHEET.__data.slice(1).forEach(function (r) { seen[r[COL.what]] = (seen[r[COL.what]] || 0) + 1; });
var victim = SHEET.__data.slice(1).filter(function (r) {
  return r[COL.key].indexOf('|t3|') === -1 && seen[r[COL.what]] === 1;
})[0];
var condemned = victim[COL.what];
victim[COL.verdict] = 'x';

var b3 = sandbox.build(true);
var text3 = sandbox.render(b3);
assert.strictEqual(b3.ledger.suppressed, 1, 'the marked item is suppressed');
assert.strictEqual(b3.result.open.length, 14);
assert.ok(text3.indexOf(condemned) === -1, 'and never appears in the digest again: ' + condemned);
assert.ok(text3.indexOf('1 hidden as wrong') > -1, 'the digest admits it is hiding something');
assert.strictEqual(b3.ledger.gone.length, 0, 'a false positive is not a win to report');

/* A suppressed item must not survive inside a meeting brief either. */
b3.briefs.forEach(function (brief) {
  brief.items.forEach(function (l) {
    assert.notStrictEqual(l.what, condemned, 'suppressed item leaked into ' + brief.title);
  });
});

/* ============== run four: a thread resolves and drops off ============== */
MESSAGES = F.MESSAGES.filter(function (m) { return m.threadId !== 't3'; });
var b4 = sandbox.build(true);
var text4 = sandbox.render(b4);
assert.ok(b4.ledger.gone.length >= 1, 'what the detector stops finding has been dealt with');
assert.ok(text4.indexOf('CLEARED SINCE THE LAST RUN') > -1, 'and the digest says so');
assert.ok(text4.indexOf("I'll connect you with Sana this week") > -1,
  'the intro promise is reported as cleared');

var b5 = sandbox.build(true);
assert.strictEqual(b5.ledger.gone.length, 0, 'cleared items are announced once, not daily');

/* ========== run six: time passes, so the list shows its own age ========== */
MESSAGES = F.MESSAGES;
sandbox.today = function () { return '2026-08-11'; };
var text6 = sandbox.render(sandbox.build(true));
assert.ok(/\d+d on the list/.test(text6), 'items carry how long they have been sitting there');

/* ------------------------------ precision ------------------------------ */
var report = sandbox.precisionReport();
assert.ok(/Tracked \d+ items\. 1 marked wrong\./.test(report), 'precision counts the marks: ' + report);
assert.ok(/% held up/.test(report), 'and turns them into a number');
assert.ok(report.indexOf('You promised') > -1, 'broken out by signal, in the digest\'s own words');

/* -------------------------------- sending ------------------------------- */
sandbox.today = function () { return F.TODAY; };
sandbox.run();
var sent = sandbox.__sent;
assert.strictEqual(sent.to, sandbox.CONFIG.sendTo);
assert.ok(/^Open loops — 2026-08-06 \(\d+ open, \d+ overdue, \d+ new\)$/.test(sent.subject),
  'subject carries the counts, new included: ' + sent.subject);
assert.ok(!/html/i.test(Object.keys(sent).join(' ')), 'plain text only — nothing to render or break');

/* ============= marking things wrong by replying to the digest ============= */
sandbox.today = function () { return F.TODAY; };
MESSAGES = F.MESSAGES;
SHEET.__data.length = 1;            // fresh ledger, header row only
props.digestKeys = undefined;

var d1 = sandbox.build(true);
var t1 = sandbox.render(d1);

/* Items are numbered straight through, so a reply can name one unambiguously. */
var numbered = t1.split('\n').filter(function (line) { return /^\s*\d+\. \[/.test(line); });
assert.strictEqual(numbered.length, d1.result.open.length, 'every open item carries a number');
numbered.forEach(function (line, i) {
  assert.strictEqual(parseInt(line, 10), i + 1, 'numbering runs 1..n across sections: ' + line);
});
assert.ok(/Reply with just its number/.test(t1), 'the digest says how to reject something');

/* The reader replies naming two of them. Found by the number the digest printed —
   which is not the risk order, because the digest groups by who acts next — and
   identified by key rather than display text, since three separate meetings all
   read "No agenda attached". */
var byNum = function (res, n) { return res.open.filter(function (l) { return l.n === n; })[0]; };
var k1 = sandbox.loopKey(byNum(d1.result, 1)), k3 = sandbox.loopKey(byNum(d1.result, 3));
REPLIES = [{ subject: 'Open loops — ' + F.TODAY + ' (15 open, 4 overdue, 15 new)',
             from: 'Assistant <' + sandbox.CONFIG.sendTo + '>', body: '1 and 3 arent real' }];

var d2 = sandbox.build(true);
var t2 = sandbox.render(d2);
assert.strictEqual(d2.marked, 2, 'both numbers in the reply were marked');
assert.ok(/Took your last reply — 2 items marked wrong/.test(t2),
  'and the digest confirms it, so the reader knows corrections land');
var survived = d2.result.open.map(sandbox.loopKey);
assert.strictEqual(survived.indexOf(k1), -1, 'item 1 of that digest is gone');
assert.strictEqual(survived.indexOf(k3), -1, 'and so is item 3');
assert.strictEqual(d2.result.open.length, d1.result.open.length - 2,
  'exactly two items left, not a whole section');

/* Replying again changes nothing — the rows are already marked. */
var d3 = sandbox.build(true);
assert.strictEqual(d3.marked, 0, 'the same reply is not counted twice');

/* A reply from anyone but the person the digest was sent to is ignored. */
REPLIES = [{ subject: 'Open loops — ' + F.TODAY + ' (x)',
             from: 'Someone Else <stranger@elsewhere.com>', body: '2 4 6' }];
var d4 = sandbox.build(true);
assert.strictEqual(d4.marked, 0, 'only the digest recipient can reject items');

/* A reply quoting a digest we have no record of resolves against nothing. */
REPLIES = [{ subject: 'Open loops — 2019-01-01 (x)',
             from: 'Assistant <' + sandbox.CONFIG.sendTo + '>', body: '1 2 3' }];
assert.strictEqual(sandbox.build(true).marked, 0, 'an unremembered digest marks nothing');
REPLIES = [];

/* A truncated read must announce itself. Silence here would make a half-read mailbox
 * look like a finished digest, and the half Gmail drops is the oldest. */
var full = sandbox.render(Object.assign({}, b1, { read: { threads: 300, capped: true } }));
assert.ok(full.indexOf('INCOMPLETE') > -1, 'hitting the read cap is stated outright');
assert.ok(full.indexOf('across 300 threads') > -1, 'and the digest says how much it read');
assert.ok(text.indexOf('INCOMPLETE') === -1, 'but an uncapped read says nothing about it');

/* preview must not record a run, or the first real send reports nothing as new. */
var before = JSON.stringify(SHEET.__data);
sandbox.preview();
assert.strictEqual(JSON.stringify(SHEET.__data), before, 'preview reads the ledger without writing it');

console.log(text);
console.log('\nrender: OK');
