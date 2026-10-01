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
var retry = require('./busy.js').retry;

var EMPTY = { rows: [], digests: {}, refs: {}, refsSince: null, seen: [], learned: [], restoreRefs: {}, restoreLog: {}, replyHashes: {}, audit: { checked: 0, missed: [], asked: {}, quiet: 0, found: 0 } };

/* A ledger that cannot be used carries exit code 4: it was read after Slack was fetched, and only its owner can repair it. */
function ledgerError(msg) { var e = new Error(msg); e.exitCode = 4; return e; }

/* A restore record that is present must be whole. An entry that is not is a damaged ledger (exit 4), not something to skip: skipping a decided request
 * could apply it again. */
function checked(x, name, ok, scalar) {
  if (x == null) return {};
  if (typeof x !== 'object' || Array.isArray(x)) throw new Error(name + ' must be an object');
  Object.keys(x).forEach(function (k) { var e = x[k]; if (!(scalar ? ok(e) : e && typeof e === 'object' && !Array.isArray(e) && ok(e))) throw new Error(name + ' entry "' + k + '" is not valid'); });
  return x;
}

function load(file) {
  try {
    var raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));   // a byte-order mark is an editor's, not damage
    /* Valid JSON is not a ledger. Every file this store writes has a rows list of lists, so
     * anything else ([], {}, a misspelled key) was written by something else, or damaged.
     * Reading it as empty made the next flush overwrite it and lose every verdict. */
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.rows) ||
        !raw.rows.every(function (r) { return Array.isArray(r); })) {
      throw new Error('it is JSON but not a ledger: "rows" must be a list of rows');
    }
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
      before: raw.before && raw.before.date && raw.before.state ? raw.before : null,
      identitySalt: typeof raw.identitySalt === 'string' && raw.identitySalt ? raw.identitySalt : undefined,
      /* Restoring a rejected item (src/restore.js). Kept outside a same-day rollback, like the digest memos. */
      restoreRefs: checked(raw.restoreRefs, 'restoreRefs', function (e) { return typeof e.key === 'string' && (e.on == null || typeof e.on === 'string'); }),
      restoreLog: checked(raw.restoreLog, 'restoreLog', function (e) {
        return (e.state === 'applied' || e.state === 'refused') && (e.key == null || typeof e.key === 'string') && typeof e.requestedAt === 'string' && !isNaN(Date.parse(e.requestedAt)) &&
          (e.shownRefs === undefined || (Array.isArray(e.shownRefs) && e.shownRefs.every(function (x) { return typeof x === 'string'; })));
      }),
      replyHashes: checked(raw.replyHashes, 'replyHashes', function (e) { return typeof e === 'string'; }, true)
    };
  } catch (e) {
    // Missing is the normal first run. Corrupt is not, and losing the verdicts in it
    // would silently un-reject everything someone has already marked wrong.
    if (e.code === 'ENOENT') return JSON.parse(JSON.stringify(EMPTY));
    throw ledgerError('Ledger at ' + file + ' could not be read (' + e.message +
      '). Open Loops did not change it. Only its owner should decide whether to move it aside or restore it: deleting it loses every verdict recorded so far.');
  }
}

function fileStore(file, sopts) {
  var state = load(file), discarded = [];
  /* The ledger's identity salt: random, made once, kept in the ledger itself so it travels with every copy and backup, and never
   * remade. A ledger that already holds person tokens but has lost its salt cannot be read back into the same people, so it is an
   * error — quietly making a new salt would split every person from their corrections. */
  var tokensIn = function (rows) { return (rows || []).some(function (r) { return /^[0-9a-f]{64}$/.test(L.cell(r[L.COL.who_id])); }); };
  var saltMissing = function () { return ledgerError('Ledger at ' + file + ' holds person identifiers but no identity salt. Restore the file it was copied from. Open Loops did not make a new salt: it would detach every person from their corrections.'); };
  var ensureSalt = function () {
    if (state.identitySalt) return state.identitySalt;
    /* A midday check never writes the ledger, so it must not make a salt either: one made in memory would differ at the next check. */
    if (sopts && sopts.noSalt) return null;
    if (tokensIn(state.rows)) throw saltMissing();
    state.identitySalt = require('crypto').randomBytes(16).toString('hex');
    return state.identitySalt;
  };

  var flush = function () {
    var dir = path.dirname(file);
    if (dir && dir !== '.' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    /* Written via a temporary file and renamed, because a run interrupted midway
     * through a direct write leaves a truncated ledger — and a truncated ledger reads
     * as "nothing was ever marked wrong". */
    var tmp = file + '.' + process.pid + '.' + require('crypto').randomBytes(3).toString('hex') + '.tmp';    // this write's own file, so a failed write removes that and nothing else
    try {
      fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
      // A reader (a check, a scan, an editor) can hold the file; on Windows the rename then fails instead of waiting.
      retry(function () { fs.renameSync(tmp, file); });
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (ignore) { /* it may not have been created */ }
      throw e;
    }
  };

  /* What this run renamed since the day's snapshot, from the key the snapshot has to the key now. A rename of a key that is itself the result of an earlier
   * one extends that chain (a -> b, then b -> c, is a -> c), so rolling back undoes every step in one. */
  var recordRenames = function (renames) {
    if (!state.before) return;
    var ren = state.before.renames = state.before.renames || {}, isTarget = {};
    Object.keys(ren).forEach(function (a) { isTarget[ren[a]] = a; });
    Object.keys(renames).forEach(function (k) { if (isTarget[k] !== undefined) ren[isTarget[k]] = renames[k]; else ren[k] = renames[k]; });
  };

  return {
    path: file,

    // Scrub the rerun snapshot too, or beginRun can resurrect yesterday's text.
    // Keep this in memory until the normal flush so --dry stays read-only.
    dropText: function () {
      var salt = ensureSalt();
      var scrub = function (s) {
        // An older row's owner becomes a token before the address is scrubbed; nothing else of it is kept.
        (s.rows || []).forEach(function (r) {
          var id = L.cell(r[L.COL.who_id]);
          if (salt && !/^[0-9a-f]{64}$/.test(id) && id !== '~' && L.cell(r[L.COL.who])) r[L.COL.who_id] = require('./identity.js').token(salt, L.cell(r[L.COL.who]));
          r[L.COL.who] = ''; r[L.COL.what] = '';
        });
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
      // A same-day re-run starts from before the first run, whose rows may hold no tokens at all: the tokens in the rows it is about to discard are what say the salt was lost.
      if (!state.identitySalt && !(sopts && sopts.noSalt) && tokensIn(state.rows)) throw saltMissing();
      if (state.before && state.before.date === date) {
        // What the earlier run today had recorded, so a run that does not re-read it can say so.
        discarded = state.rows.filter(function (r) { return L.cell(r[L.COL.verdict]); })
          .map(function (r) { return L.cell(r[L.COL.key]); });
        var keep = state.before, refs = state.refs, since = state.refsSince, salt = state.identitySalt;
        var restoreRefs = state.restoreRefs, restoreLog = state.restoreLog, replyHashes = state.replyHashes;
        state = JSON.parse(JSON.stringify(keep.state));
        state.before = keep;
        // The salt is not part of what a re-run rolls back: a snapshot taken before it was made must not unmake it.
        if (salt) state.identitySalt = salt;
        /* Except the digests already posted. The earlier run today is rolled back, but its
         * digest is in the DM and may have been answered — by its numbering, not this run's. */
        state.refs = refs;
        state.refsSince = since;
        /* Nor is what a restore did, which replies were already read, or the references to rejected items: a re-run that forgot them would apply
         * a reply an earlier restore had voided, or lose the name of an item. */
        state.restoreRefs = restoreRefs; state.restoreLog = restoreLog; state.replyHashes = replyHashes;
        /* The rows are back to the keys the snapshot has. The digest memos, restore references and restore log are not rolled back, so they still name the
         * keys this day's earlier run migrated to: put them back, or a restore, its fence and the replies it voided no longer find their rows. The re-run
         * migrates again. Two keys renamed to one cannot be told apart on the way back, and are left. */
        var back = {}, clash = {};
        Object.keys(keep.renames || {}).forEach(function (a) { var b = keep.renames[a]; if (back[b] !== undefined) clash[b] = 1; back[b] = a; });
        Object.keys(clash).forEach(function (b) { delete back[b]; });
        var unmap = function (k) { return typeof k === 'string' && back[k] !== undefined ? back[k] : k; };
        Object.keys(state.refs).forEach(function (r) { if (state.refs[r] && state.refs[r].keys) state.refs[r].keys = state.refs[r].keys.map(unmap); });
        Object.keys(state.restoreRefs).forEach(function (r) { var e = state.restoreRefs[r]; if (e) e.key = unmap(e.key); });
        Object.keys(state.restoreLog).forEach(function (id) { var e = state.restoreLog[id]; if (e && e.key) e.key = unmap(e.key); });
        keep.renames = {};
      } else {
        var snap = JSON.parse(JSON.stringify(state));
        delete snap.before;
        state.before = { date: date, state: snap };
      }
    },

    identitySalt: ensureSalt,

    // Live objects, written by the digest only: its next flush records them.
    restoreState: function () { return { refs: state.restoreRefs, log: state.restoreLog, hashes: state.replyHashes }; },

    // Keys that carried a verdict before a same-day re-run rolled the ledger back.
    discardedVerdicts: function () { return discarded.slice(); },

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

    /* Legacy rows re-keyed by reconcileLegacy: an older digest's numbered list, and a reply reference's, name the old
     * key, and a reply to "1" would otherwise look for a row that is no longer there. In memory until the next flush. */
    /* A record set aside as K|ambiguous keeps its restore reference, its log entries and its date: they follow the key. Digest memos are left as they were. */
    followKeys: function (renames) {
      recordRenames(renames);
      Object.keys(state.restoreRefs).forEach(function (r) { var e = state.restoreRefs[r]; if (e && renames[e.key]) e.key = renames[e.key]; });
      Object.keys(state.restoreLog).forEach(function (id) { var e = state.restoreLog[id]; if (e && e.key && renames[e.key]) e.key = renames[e.key]; });
    },

    migrateKeys: function (renames) {
      recordRenames(renames);
      var map = function (list) { return list.map(function (k) { return renames[k] || k; }); };
      Object.keys(state.digests).forEach(function (d) { state.digests[d] = map(state.digests[d]); });
      Object.keys(state.refs).forEach(function (r) { if (state.refs[r].keys) state.refs[r].keys = map(state.refs[r].keys); });
      // A reference to a rejected item names the item, not its key: when the key moves, the reference follows.
      Object.keys(state.restoreRefs).forEach(function (r) { var e = state.restoreRefs[r]; if (e && renames[e.key]) e.key = renames[e.key]; });
      Object.keys(state.restoreLog).forEach(function (id) { var e = state.restoreLog[id]; if (e && e.key && renames[e.key]) e.key = renames[e.key]; });
    },

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
