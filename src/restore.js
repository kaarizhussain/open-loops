/* Putting a rejected item back.
 *
 * A reply rejects an item and the digest hides it for good. Until now nothing undid that. This is the way back, and it keeps two rules the rest
 * of the tool depends on:
 *
 *   - The digest is the ledger's only writer. `tools/corrections.js` never touches the ledger: it appends a request to `restores.json`, which
 *     it alone writes. The digest reads the requests, applies them, and records what happened in the ledger (`restoreLog`). Whether a request is
 *     pending, applied or refused is read from there, so the tool never has to write what the digest decided.
 *   - A restore clears the verdict on the row that is already there. `first_seen` is untouched, so the item keeps its age and nothing new is
 *     invented. If the row is gone it says so; it never makes one.
 *
 * What survives what:
 *   - A reference to a rejected item is minted once, when the digest first sees the rejection, and stored as `restoreRefs: { ref: { key, on } }`.
 *     It is NOT a hash of the key: keys migrate, and the code that migrates a key rewrites the reference's target (store.migrateKeys).
 *   - A same-day re-run rolls the ledger back to before the day's first run, which would undo a restore and re-apply the reply it undid. The log
 *     is kept outside that rollback, like the digest memos and the salt. Each applied restore is a fence: a reply typed before the request cannot
 *     reject that item again. A reply typed after it can, and then the restore does not clear it.
 *   - Replies are matched by a short hash of their text (`replyHashes`, also kept outside the rollback), so an old reply that was edited since is
 *     told apart from one already processed.
 *   - A post can succeed before its confirmation fails, so an acknowledgement is at-least-once: it is repeated until a digest that carried it is
 *     confirmed delivered (status.json's last delivered ref), and then stops. A restore itself is applied once.
 */
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var retry = require('./busy.js').retry;
var L = require('./ledger.js');

var REF = /^[0-9a-f]{4,16}$/, DIGEST_REF = /^[0-9a-f]{4}$/, ID = /^[0-9a-f]{8}$/;
var KEEP_CARRIERS = 50;   // the references of the digests that carried a note, kept so a confirmation of any of them is recognised
var KEEP_LOG_DAYS = 120, KEEP_REF_DAYS = 365, KEEP_HASHES = 400;

function file(dir) { return path.join(dir, 'restores.json'); }

function valid(r) {
  if (!r || typeof r !== 'object' || !ID.test(r.id) || isNaN(Date.parse(r.requestedAt))) return false;
  if (typeof r.ref === 'string') return REF.test(r.ref);
  return !!r.digest && DIGEST_REF.test(r.digest.ref) && Number.isInteger(r.digest.n) && r.digest.n >= 1 && r.digest.n <= 999;
}

/* What the digest reads. A file that cannot be read gives no requests (and says so): the digest never writes it, so it cannot repair it. */
function loadRequests(dir) {
  var text;
  try { text = retry(function () { return fs.readFileSync(file(dir), 'utf8'); }); }
  catch (e) { return e.code === 'ENOENT' ? { requests: [], damaged: false } : { requests: [], damaged: true }; }
  try {
    var o = JSON.parse(text.replace(/^﻿/, ''));
    if (!o || !Array.isArray(o.requests)) throw new Error('shape');
    return { requests: o.requests.filter(valid), damaged: false };
  } catch (e) { return { requests: [], damaged: true }; }
}

/* ------------------------------------------------------------------ the tool's side: the only writer of restores.json */

function writeRequests(dir, requests) {
  var f = file(dir), tmp = f + '.' + process.pid + '.' + crypto.randomBytes(3).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ requests: requests }, null, 1));
  retry(function () { fs.renameSync(tmp, f); });
}

/* Only the structured request is kept: an id, what it points at, when. Never the words the reader used. A request for something already
 * waiting is the same request. Finished requests the ledger has logged are dropped after a month. */
function addRequest(dir, target, log, now) {
  var cur = loadRequests(dir);
  if (cur.damaged) throw new Error('restores.json could not be read, so nothing was queued. The file was preserved. Ask your assistant to inspect it before trying again.');
  var same = function (r) { return target.ref ? r.ref === target.ref : r.digest && r.digest.ref === target.digest.ref && r.digest.n === target.digest.n; };
  var waiting = cur.requests.filter(function (r) { return same(r) && !log[r.id]; })[0];
  if (waiting) return { id: waiting.id, existing: true };
  var cutoff = now.getTime() - 30 * 864e5;
  var keep = cur.requests.filter(function (r) { return !(log[r.id] && Date.parse(r.requestedAt) < cutoff); });
  var id;
  do { id = crypto.randomBytes(4).toString('hex'); } while (keep.some(function (r) { return r.id === id; }) || log[id]);
  var req = { id: id, requestedAt: now.toISOString() };
  if (target.ref) req.ref = target.ref; else req.digest = { ref: target.digest.ref, n: target.digest.n };
  keep.push(req);
  writeRequests(dir, keep);
  return { id: id, existing: false };
}

/* ------------------------------------------------------------------ the digest's side */

function refOf(refs, key) {
  var found = null;
  Object.keys(refs).forEach(function (r) { if (refs[r] && refs[r].key === key) found = r; });
  return found;
}

/* Every rejected row gets a reference, once. Reusing the existing one means an item rejected, restored and rejected again keeps its name. */
function mintRefs(store, rows, today) {
  var st = store.restoreState();
  rows.forEach(function (r) {
    if (L.cell(r[L.COL.verdict]) !== 'x') return;
    var key = L.cell(r[L.COL.key]);
    if (!key || refOf(st.refs, key)) return;
    var ref;
    do { ref = crypto.randomBytes(4).toString('hex'); } while (st.refs[ref]);
    st.refs[ref] = { key: key, on: today };
  });
}

function resolve(req, st, store) {
  if (req.ref) {
    if (st.refs[req.ref]) return { key: st.refs[req.ref].key, ref: req.ref };
    var hits = Object.keys(st.refs).filter(function (r) { return r.indexOf(req.ref) === 0; });
    if (hits.length === 1) return { key: st.refs[hits[0]].key, ref: hits[0] };
    return { refuse: hits.length ? 'ambiguous_prefix' : 'unknown_ref', ref: req.ref };
  }
  var memo = store.recallRef ? store.recallRef(req.digest.ref) : null, key = memo && memo.keys ? memo.keys[req.digest.n - 1] : null;
  if (!key) return { refuse: 'unknown_ref', ref: req.digest.ref + '#' + req.digest.n };
  return { key: key, ref: refOf(st.refs, key) || req.digest.ref + '#' + req.digest.n };
}

function entry(state, over) {
  return Object.assign({ state: state, reason: null, key: null, ref: null, requestedAt: null, on: null, firstSeen: null,
    shown: 0, shownIn: null, shownRefs: [], acked: false, superseded: false }, over || {});
}

/* Before replies are read: refuse what cannot point at anything, and say which items are fenced. `active` is what has to be settled once the
 * replies are in — the pending requests, and those applied earlier TODAY, because a same-day re-run has just undone them. */
function begin(o) {
  var st = o.store.restoreState(), fences = {}, active = [];
  Object.keys(st.log).forEach(function (id) {
    var e = st.log[id];
    if (e.state === 'applied' && e.key) fences[e.key] = Math.max(fences[e.key] || 0, Date.parse(e.requestedAt));
    if (e.state === 'applied' && e.key && e.on === o.today) active.push({ id: id, key: e.key, ref: e.ref, requestedAt: e.requestedAt, pending: false });
  });
  o.requests.forEach(function (r) {
    if (st.log[r.id]) return;            // decided already, in this ledger or one a same-day re-run rolled back: never decided twice
    var res = resolve(r, st, o.store);
    if (res.refuse) { st.log[r.id] = entry('refused', { reason: res.refuse, ref: res.ref, requestedAt: r.requestedAt, on: o.today }); return; }
    fences[res.key] = Math.max(fences[res.key] || 0, Date.parse(r.requestedAt));
    active.push({ id: r.id, key: res.key, ref: res.ref, requestedAt: r.requestedAt, pending: true });
  });
  return { fences: fences, active: active };
}

/* After replies: clear what is to be cleared. A rejection typed AFTER the request is the later intent and stays in force; a reply typed before it
 * was fenced out when the replies were read, so it cannot come back. */
function settle(o) {
  var st = o.store.restoreState(), byKey = {};
  o.rows.forEach(function (r) { byKey[L.cell(r[L.COL.key])] = r; });
  o.ctx.active.forEach(function (a) {
    var row = byKey[a.key], verdict = row ? L.cell(row[L.COL.verdict]) : '';
    var later = (o.replies.rejectedAt[a.key] || 0) > Date.parse(a.requestedAt), out;
    if (!row) { if (!a.pending) return; out = { state: 'refused', reason: 'not_tracked' }; }
    else if (verdict === 'x' && later) out = { state: 'applied', superseded: true };
    else if (verdict === 'x') { row[L.COL.verdict] = ''; out = { state: 'applied' }; }
    else if (o.replies.fencedKeys[a.key]) out = { state: 'applied' };     // the rejection it voided was an older reply, which was not applied again
    else if (a.pending) out = { state: 'refused', reason: 'not_rejected' };
    else return;
    if (a.pending) {
      st.log[a.id] = entry(out.state, { reason: out.reason || null, key: a.key, ref: a.ref, requestedAt: a.requestedAt, on: o.today,
        firstSeen: row ? L.cell(row[L.COL.first_seen]) : null, superseded: !!out.superseded });
    } else st.log[a.id].superseded = !!out.superseded;
  });
}

/* What the digest says about requests, and the bookkeeping that makes it say so until it is known to have arrived. A digest that carried a note
 * and was then confirmed delivered ends it. One that was not (the post failed, or its confirmation did) leaves it, and the note is carried again,
 * worded as a repeat. There is no cap: neither a number of attempts nor a number of repetitions is a confirmation, so only the confirmation ends it. */
function notes(o) {
  var st = o.store.restoreState(), out = [], now = {}, more = 0;
  (o.rows || []).forEach(function (r) { now[L.cell(r[L.COL.key])] = L.cell(r[L.COL.verdict]); });
  Object.keys(st.log).sort(function (a, b) { return String(st.log[a].on).localeCompare(String(st.log[b].on)) || a.localeCompare(b); }).forEach(function (id) {
    var e = st.log[id];
    if (e.acked) return;
    // Confirmed delivered: the last delivered digest is one that carried this note, the latest or an earlier one.
    if (o.deliveredRef && (e.shownRefs || []).concat(e.shownIn ? [e.shownIn] : []).indexOf(o.deliveredRef) > -1) { e.acked = true; return; }
    // Only a note that is actually displayed counts as carried: one held back by the display limit has not been said, so a delivery confirms nothing about it.
    if (o.limit && out.length >= o.limit) { more++; return; }
    var repeat = e.shown > 0;
    e.shown++; e.shownIn = o.ref;
    e.shownRefs = (e.shownRefs || []).filter(function (r) { return r !== o.ref; }).concat([o.ref]).slice(-KEEP_CARRIERS);
    /* What it says is what is true now: an item restored and rejected again, in this run or on any later day, stays hidden. */
    out.push({ kind: e.state, reason: e.reason, ref: e.ref, firstSeen: e.firstSeen, superseded: e.superseded || (e.state === 'applied' && now[e.key] === 'x'), repeat: repeat,
      n: e.key ? o.keys.indexOf(e.key) + 1 || null : null });
  });
  out.more = more;
  return out;
}

/* Old entries and references go. Hashes are capped: they only have to outlast the replies still readable in the DM.
 *
 * A log entry is the only record that a request was decided, so it goes only when nothing depends on it:
 *   - never while its acknowledgement is unconfirmed: only a confirmed delivery ends one, and age is not a confirmation;
 *   - never while its request is still in restores.json, or while that file cannot be read: without the entry the request would look new, be applied
 *     again, and undo a rejection made since.
 * Once confirmed, old, and gone from the file, it can be dropped: nothing can apply it again. */
function prune(store, today, queued, rows) {
  var st = store.restoreState(), cut = function (days) { return new Date(Date.parse(today + 'T00:00:00Z') - days * 864e5).toISOString().slice(0, 10); };
  var inFile = {};
  ((queued && queued.requests) || []).forEach(function (r) { inFile[r.id] = 1; });
  if (queued && !queued.damaged) {
    Object.keys(st.log).forEach(function (id) {
      var e = st.log[id];
      if (e.acked === true && e.on && e.on < cut(KEEP_LOG_DAYS) && !inFile[id]) delete st.log[id];
    });
  }
  /* A reference goes after a year only if nothing needs it: its item is no longer rejected, and no request still in restores.json points at it.
   * A reference the list shows (an item that is rejected) must still be there when the digest processes the request made from it. When the file
   * cannot be read, what it holds is unknown, so no reference is dropped. */
  var needed = {};
  (rows || []).forEach(function (r) { if (L.cell(r[L.COL.verdict]) === 'x') needed[L.cell(r[L.COL.key])] = 1; });
  ((queued && queued.requests) || []).forEach(function (q) { var res = resolve(q, st, store); if (res.key) needed[res.key] = 1; });
  Object.keys(st.refs).forEach(function (r) {
    var e = st.refs[r];
    if (e.on && e.on < cut(KEEP_REF_DAYS) && queued && !queued.damaged && !needed[e.key]) delete st.refs[r];
  });
  Object.keys(st.hashes).slice(0, -KEEP_HASHES).forEach(function (k) { delete st.hashes[k]; });
}

function hashOf(text) { return crypto.createHash('sha1').update(String(text || '').trim()).digest('hex').slice(0, 12); }

module.exports = { REF: REF, DIGEST_REF: DIGEST_REF, file: file, loadRequests: loadRequests, addRequest: addRequest, mintRefs: mintRefs, resolve: resolve,
  begin: begin, settle: settle, notes: notes, prune: prune, hashOf: hashOf, refOf: refOf };
