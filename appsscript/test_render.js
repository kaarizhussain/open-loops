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
