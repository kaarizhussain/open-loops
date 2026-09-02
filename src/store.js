/* The ledger, in a file.
 *
 * The Apps Script runtime keeps its rows in a spreadsheet and its two memos in script
 * properties. Everywhere else there is no spreadsheet, so this is the same six
 * operations backed by one JSON file:
 *
 *   { rows: [[...], ...], digests: { 'YYYY-MM-DD': [key, ...] }, seen: [id, ...] }
 *
 * Rows keep the spreadsheet's array-of-arrays shape rather than becoming objects.
 * That looks like an odd choice for a JSON file, and it is deliberate: the same
 * ledger can then be moved between the two runtimes, and src/ledger.js needs no
 * notion of which one it is running in.
 *
 * ponytail: reads and writes the whole file each run. A ledger is one row per
 * detected item over a retention window — thousands at the very worst — and a run
 * happens once a day. Reach for a database when someone is running this at a scale
 * where that sentence stops being true.
 */
var fs = require('fs');
var path = require('path');
var L = require('./ledger.js');

var EMPTY = { rows: [], digests: {}, seen: [], learned: [] };

function load(file) {
  try {
    var raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      rows: Array.isArray(raw.rows) ? raw.rows : [],
      digests: raw.digests && typeof raw.digests === 'object' ? raw.digests : {},
      seen: Array.isArray(raw.seen) ? raw.seen : [],
      learned: Array.isArray(raw.learned) ? raw.learned : []
    };
  } catch (e) {
    // Missing is the normal first run. Corrupt is not, and losing the verdicts in it
    // would silently un-reject everything someone has already marked wrong.
    if (e.code === 'ENOENT') return JSON.parse(JSON.stringify(EMPTY));
    throw new Error('Ledger at ' + file + ' could not be read (' + e.message +
      '). Move it aside to start fresh — deleting it loses every verdict recorded so far.');
  }
}

function fileStore(file) {
  var state = load(file);

  var flush = function () {
    var dir = path.dirname(file);
    if (dir && dir !== '.' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    /* Written via a temporary file and renamed, because a run interrupted midway
     * through a direct write leaves a truncated ledger — and a truncated ledger reads
     * as "nothing was ever marked wrong". */
    var tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
    fs.renameSync(tmp, file);
  };

  return {
    path: file,

    readLedger: function () {
      return state.rows.map(function (r) { return r.map(L.cell); })
                       .filter(function (r) { return r[L.COL.key]; });
    },

    writeLedger: function (rows) {
      state.rows = rows.map(function (r) { return r.slice(); });
      flush();
    },

    rememberDigest: function (date, keys) {
      state.digests[date] = keys;
      // A week is plenty; a reply older than the memo has nothing left to resolve against.
      Object.keys(state.digests).sort().slice(0, -7).forEach(function (d) {
        delete state.digests[d];
      });
      flush();
    },

    recallDigest: function (date) { return state.digests[date] || []; },

    seenReplies: function () { return state.seen.slice(); },

    rememberReplies: function (ids) {
      state.seen = ids.slice(-200);
      flush();
    },

    /* Phrases the tool muted on its own, and the evidence it did it on.
     *
     * Kept here rather than in config because config is what a person wrote and this
     * is what the tool concluded — mixing the two makes it impossible to tell which
     * decisions were yours. Every entry carries its count and date so the reasoning
     * can be checked, and deleting a line undoes it. */
    learnedMutes: function () { return state.learned.slice(); },

    remember: function (entries) {
      state.learned = state.learned.concat(entries);
      flush();
    }
  };
}

module.exports = { fileStore: fileStore };
