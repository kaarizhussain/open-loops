/* The ledger, in a file.
 *
 * The Apps Script runtime keeps its rows in a spreadsheet and its two memos in script
 * properties. Everywhere else there is no spreadsheet, so this is the same six
 * operations backed by one JSON file:
 *
 *   { rows: [[...], ...], digests: { 'YYYY-MM-DD': [key, ...] }, seen: [id, ...],
 *     refs: { '<ref>': { date, keys, asked } }, refsSince: 'YYYY-MM-DD' }
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

var EMPTY = { rows: [], digests: {}, refs: {}, refsSince: null, seen: [], learned: [], audit: { checked: 0, missed: [], asked: {}, quiet: 0, found: 0 } };

function load(file) {
  try {
    var raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      rows: Array.isArray(raw.rows) ? raw.rows : [],
      digests: raw.digests && typeof raw.digests === 'object' ? raw.digests : {},
      refs: raw.refs && typeof raw.refs === 'object' ? raw.refs : {},
      refsSince: typeof raw.refsSince === 'string' ? raw.refsSince : null,
      seen: Array.isArray(raw.seen) ? raw.seen : [],
      learned: Array.isArray(raw.learned) ? raw.learned : [],
      audit: raw.audit && typeof raw.audit === 'object'
        ? { checked: raw.audit.checked || 0, quiet: raw.audit.quiet || 0,
            found: raw.audit.found || 0,
            missed: Array.isArray(raw.audit.missed) ? raw.audit.missed : [],
            asked: raw.audit.asked || {} }
        : { checked: 0, missed: [], asked: {} },
      before: raw.before && raw.before.date && raw.before.state ? raw.before : null
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

    // Scrub the rerun snapshot too, or beginRun can resurrect yesterday's text.
    // Keep this in memory until the normal flush so --dry stays read-only.
    dropText: function () {
      var scrub = function (s) {
        (s.rows || []).forEach(function (r) { r[L.COL.who] = ''; r[L.COL.what] = ''; });
        s.learned = [];
        if (s.before) scrub(s.before.state);
      };
      scrub(state);
    },

    /* The run that counts for a date is the last one.
     *
     * The first real run read a thread wrong, was recorded, and was run again corrected —
     * and the corrected digest said "0 new", because the bad run had spent every NEW flag,
     * and listed as cleared an item that was still open. So the first run of a date keeps
     * a copy of the ledger as it stood before it, and any later run that day starts from
     * that copy: a re-run reads exactly as if the earlier one never happened.
     *
     * ponytail: a reply typed under an earlier digest the same day has nothing to resolve
     * against once that run is undone, so it is dropped. Rare, and the reply can be sent
     * again under the digest that replaced it. */
    beginRun: function (date) {
      if (state.before && state.before.date === date) {
        var keep = state.before, refs = state.refs, since = state.refsSince;
        state = JSON.parse(JSON.stringify(keep.state));
        state.before = keep;
        /* Except the digests already posted. The earlier run today is rolled back, but its
         * digest is in the DM and may have been answered — by its numbering, not this run's. */
        state.refs = refs;
        state.refsSince = since;
      } else {
        var snap = JSON.parse(JSON.stringify(state));
        delete snap.before;
        state.before = { date: date, state: snap };
      }
    },

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

    /* The same memo, by the reference printed in the digest's header rather than its date.
     * A date names a day, and two digests can share one: a re-run, or another setup posting
     * into the same DM from its own ledger. Only a reference says which list a reply saw. */
    rememberRef: function (ref, date, keys, asked) {
      state.refs[ref] = { date: date, keys: keys, asked: asked || [] };
      if (!state.refsSince) state.refsSince = date;
      Object.keys(state.refs).sort(function (a, b) {
        return state.refs[a].date < state.refs[b].date ? -1 : state.refs[a].date > state.refs[b].date ? 1 : 0;
      }).slice(0, -14).forEach(function (r) { delete state.refs[r]; });
      flush();
    },

    recallRef: function (ref) { return state.refs[ref] || null; },

    // The first day digests carried a reference. A digest without one from then on is not ours.
    refsSince: function () { return state.refsSince; },

    // Every date a digest was produced for, so a read can tell whether it missed one.
    digestDates: function () {
      var d = Object.keys(state.digests);
      Object.keys(state.refs).forEach(function (r) { d.push(state.refs[r].date); });
      return d;
    },

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
    },

    /* The spot check: what was asked about, and what came back.
     *
     * `asked` maps a digest date to the message ids shown that day, so an answer given
     * tomorrow resolves against what was actually on the page — the same problem the
     * numbered items have, and the same solution. */
    audit: function () { return state.audit; },

    rememberAudit: function (date, ids, quiet, found) {
      state.audit.asked[date] = ids;
      if (quiet != null) state.audit.quiet = quiet;
      if (found != null) state.audit.found = found;
      Object.keys(state.audit.asked).sort().slice(0, -7).forEach(function (d) {
        delete state.audit.asked[d];
      });
      flush();
    },

    recordMisses: function (entries, checkedDelta) {
      state.audit.missed = state.audit.missed.concat(entries);
      state.audit.checked += checkedDelta || 0;
      flush();
    }
  };
}

module.exports = { fileStore: fileStore };
