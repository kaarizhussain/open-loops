/* Open Loops — the ledger.
 *
 * The detector is stateless on purpose: every run rebuilds the list from the mail.
 * That is right for the engine and wrong for a daily email. An unchanged list
 * arriving every morning is one nobody opens by Thursday, and a tool that gets
 * ignored on day four is indistinguishable from one that never worked.
 *
 * So this is the memory between runs: what was already on the list, what is new
 * today, what fell off because it got dealt with, and what the reader has told us
 * was never real in the first place.
 *
 * A spreadsheet rather than a database because the reader has to be able to type
 * in it. Marking an item wrong is the entire validation loop, and it has to cost
 * one keystroke or it does not get done for a fortnight running.
 */

var LEDGER_COLS = ['key', 'first_seen', 'last_seen', 'gone_on', 'type', 'who', 'what', 'verdict'];
var COL = {};
LEDGER_COLS.forEach(function (name, i) { COL[name] = i; });

function daysApart(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 864e5);
}

/* Sheets hands back a Date object for any cell it decided looks like one, which
 * would turn a stored '2026-08-06' into a string none of the comparisons here
 * expect. Normalise on the way in. The offset correction stops a local-midnight
 * Date sliding back a day when it goes through UTC. */
function cell(c) {
  if (c instanceof Date) {
    return new Date(c.getTime() - c.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }
  return c == null ? '' : String(c).trim();
}

/* The verdict is typed by a human into a spreadsheet cell, so accept the shapes a
 * human actually types. Anything else — blank included — means not yet judged. */
function isWrong(v) {
  return /^(x|n|no|nope|wrong|false|fp)\b/i.test(cell(v));
}

/* Fold this run's detections into what we already knew.
 *
 * Mutates `rows` (the sheet's contents) and annotates each surviving loop with
 * isNew / trackedDays so the digest can say what changed. Returns the loops that
 * should actually be shown — anything the reader marked wrong never reaches the
 * digest again. */
function mergeLedger(rows, loops, today) {
  var byKey = {}, touched = {}, shown = [], fresh = 0, suppressed = 0;
  rows.forEach(function (r) { byKey[cell(r[COL.key])] = r; });

  loops.forEach(function (l) {
    var k = loopKey(l), row = byKey[k];
    touched[k] = 1;

    if (row && isWrong(row[COL.verdict])) { suppressed++; return; }

    if (row) {
      row[COL.last_seen] = today;
      row[COL.gone_on] = '';                     // it is back, so it never left
      l.isNew = false;
      l.firstSeen = cell(row[COL.first_seen]);
      l.trackedDays = daysApart(l.firstSeen, today);
    } else {
      row = [k, today, today, '', l.type, l.who || '', l.what || '', ''];
      byKey[k] = row;
      rows.push(row);
      l.isNew = true;
      l.firstSeen = today;
      l.trackedDays = 0;
      fresh++;
    }
    shown.push(l);
  });

  /* Anything tracked that the detector no longer finds has been dealt with — the
   * reply landed, the agenda went out, the promise was kept. Worth saying once,
   * because a digest that only ever grows is a nag rather than a tool.
   *
   * ponytail: an item also falls off when its thread ages past lookbackDays, so a
   * long-silent loop reads as resolved when it was only forgotten. If that starts
   * lying, diff against the thread ids actually read rather than trusting absence.
   *
   * Keyed on what this run actually produced rather than on last_seen matching
   * today, so that running the digest twice in one day does not quietly swallow
   * everything that cleared between the two.
   */
  var gone = [];
  rows.forEach(function (r) {
    if (touched[cell(r[COL.key])]) return;
    if (cell(r[COL.gone_on]) || isWrong(r[COL.verdict])) return;
    r[COL.gone_on] = today;
    gone.push(r);
  });

  return { shown: shown, fresh: fresh, suppressed: suppressed, gone: gone };
}

/* The number the fortnight is for.
 *
 * ponytail: an unmarked row counts as correct, which flatters the result. Explicit
 * right/wrong on every item is the honest measure, but nobody sustains it for two
 * weeks, and a test that gets abandoned yields no number at all. Mark the misses.
 */
function precision(rows) {
  var byType = {}, total = 0, wrong = 0;
  rows.forEach(function (r) {
    var t = cell(r[COL.type]) || '?';
    var b = byType[t] || (byType[t] = { total: 0, wrong: 0 });
    b.total++; total++;
    if (isWrong(r[COL.verdict])) { b.wrong++; wrong++; }
  });
  return { total: total, wrong: wrong, byType: byType };
}

/* --- the Sheet itself. Everything above this line runs outside Apps Script. --- */

function ledgerSheet() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('ledgerId'), ss = null;
  if (id) {
    try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; }  // deleted or unshared
  }
  if (!ss) {
    ss = SpreadsheetApp.create('Open Loops — ledger');
    props.setProperty('ledgerId', ss.getId());
    Logger.log('Created the ledger: ' + ss.getUrl());
  }
  var sh = ss.getSheets()[0];
  if (sh.getLastRow() === 0) {
    sh.appendRow(LEDGER_COLS);
    sh.setFrozenRows(1);
  }
  return sh;
}

function readLedger(sh) {
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, LEDGER_COLS.length).getValues()
    .map(function (r) { return r.map(cell); })
    .filter(function (r) { return r[COL.key]; });
}

function writeLedger(sh, rows) {
  if (rows.length) sh.getRange(2, 1, rows.length, LEDGER_COLS.length).setValues(rows);
}

if (typeof module !== 'undefined') {
  module.exports = {
    mergeLedger: mergeLedger, precision: precision, isWrong: isWrong, cell: cell,
    daysApart: daysApart, LEDGER_COLS: LEDGER_COLS, COL: COL
  };
}
