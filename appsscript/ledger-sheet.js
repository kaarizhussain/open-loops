/* Where the ledger actually lives when this runs in Apps Script.
 *
 * The thinking is all in src/ledger.js, which knows nothing about Google. This is
 * the storage half: a spreadsheet for the rows, and script properties for the two
 * memos that let a reply be resolved against the digest it was answering.
 *
 * A second runtime needs its own version of exactly these functions and nothing
 * else — see src/store.js for the file-backed one.
 */


/* What each digest contained, so a reply to it can be resolved. Keyed by the date in
 * its subject line, which is the only thing a reply reliably carries back. */
var DIGEST_MEMO = 'digestKeys';

function rememberDigest(date, keys) {
  var props = PropertiesService.getScriptProperties(), all = {};
  try { all = JSON.parse(props.getProperty(DIGEST_MEMO) || '{}'); } catch (e) { all = {}; }
  all[date] = keys;
  // A week is plenty; a reply older than the memo has nothing left to resolve against.
  Object.keys(all).sort().slice(0, -7).forEach(function (d) { delete all[d]; });
  props.setProperty(DIGEST_MEMO, JSON.stringify(all));
}

function recallDigest(date) {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(DIGEST_MEMO);
    return JSON.parse(raw || '{}')[date] || [];
  } catch (e) { return []; }
}

/* Which replies have already been acted on.
 *
 * A reply sits in the mailbox for as long as the search window, so without this it is
 * re-read on every run for a week — and because the numbering it referred to belongs
 * to one particular digest, re-applying it against a later, shorter list marks
 * different items each time. One reply would quietly eat the list.
 */
var SEEN_MEMO = 'seenReplies';

function seenReplies() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(SEEN_MEMO) || '[]'); }
  catch (e) { return []; }
}

function rememberReplies(ids) {
  // Bounded: an id older than the digest memo has nothing left to resolve against.
  PropertiesService.getScriptProperties().setProperty(SEEN_MEMO, JSON.stringify(ids.slice(-200)));
}

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
  var had = sh.getLastRow() - 1;
  if (rows.length) sh.getRange(2, 1, rows.length, LEDGER_COLS.length).setValues(rows);
  // Pruning shortens the list, and anything below what was just written is a row
  // that was supposed to be forgotten still sitting there in plain sight.
  var surplus = had - rows.length;
  if (surplus > 0) sh.deleteRows(2 + rows.length, surplus);
}

