/* Diagnostic reports — what one may contain, and nothing else.
 *
 * Shared by the sender (tools/report.js, and the runner that queues reports) and the
 * report server (report-worker/worker.mjs), so both sides check the same shape.
 *
 * A report is built from enums, small integers and one code-location pattern. There is
 * no free-text field, so no message text, name, path or error message can travel in one
 * however it was assembled. `clean` returns a fresh object holding only checked fields,
 * or null; the server rejects anything `clean` would have changed.
 *
 * No require() here: this file also runs inside a Cloudflare Worker.
 */

// Filled in when the Worker is deployed. Unset, reports stay queued and nothing is sent.
var ENDPOINT = null;

var KINDS = ['run_failed', 'item_wrong', 'item_missed'];
var STAGES = ['pull', 'fetch_slack', 'fetch_calendar', 'runner', 'post', 'readback'];
var ERRORS = ['SyntaxError', 'TypeError', 'RangeError', 'ReferenceError', 'Error', 'Other'];
var SIGNALS = ['owed_by_us', 'owed_to_us', 'unanswered_ask', 'awaiting_reply',
               'agreed_unscheduled', 'no_followup', 'unprepped_meeting'];
var HOSTS = ['claude', 'codex'];
var OSES = ['win32', 'darwin', 'linux', 'other'];

var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Our own files by name, so a location can never be some other file a path happened to hold.
var WHERE = /^(slack-run\.js|src\/(?:calendar|config|diagnostics|digest|fixture|ledger|loops|slack|slack-coverage|slack-json|store)\.js|tools\/report\.js):\d{1,5}$/;
var DAY = /^\d{4}-\d{2}-\d{2}$/;

function oneOf(list) { return function (v) { return list.indexOf(v) > -1; }; }
function int(lo, hi) { return function (v) { return Number.isInteger(v) && v >= lo && v <= hi; }; }
function match(re) { return function (v) { return typeof v === 'string' && re.test(v); }; }

var COMMON = {
  schema: function (v) { return v === 1; },
  install: match(UUID),
  id: match(/^[0-9a-f]{16}$/),
  kind: oneOf(KINDS),
  version: match(/^([0-9a-f]{7}|unknown)$/),
  host: oneOf(HOSTS),
  node: int(1, 99),
  os: oneOf(OSES),
  date: match(DAY)
};
var BY_KIND = {
  run_failed: {
    stage: oneOf(STAGES),
    error: oneOf(ERRORS),
    where: function (v) { return Array.isArray(v) && v.length <= 3 && v.every(match(WHERE)); }
  },
  item_wrong: { signal: oneOf(SIGNALS), age_days: int(0, 60), listed: int(0, 99) },
  item_missed: { sampled: int(0, 9), missed: int(0, 9) }
};

// An example is the one thing that carries text, and only after the reader approved it.
var EXAMPLE = {
  schema: COMMON.schema, install: COMMON.install, id: COMMON.id,
  kind: function (v) { return v === 'example'; },
  version: COMMON.version, date: COMMON.date,
  signal: oneOf(SIGNALS), first_seen: match(DAY),
  text: function (v) { return typeof v === 'string' && v.length > 0 && v.length <= 800; }
};

function fieldsFor(r) {
  if (!r || typeof r !== 'object') return null;
  if (r.kind === 'example') return EXAMPLE;
  var extra = BY_KIND[r.kind];
  if (!extra) return null;
  var all = {};
  Object.keys(COMMON).forEach(function (k) { all[k] = COMMON[k]; });
  Object.keys(extra).forEach(function (k) { all[k] = extra[k]; });
  return all;
}

/* A copy holding exactly the allowed fields, each checked — or null. */
function clean(r) {
  var f = fieldsFor(r);
  if (!f) return null;
  var out = {};
  var ok = Object.keys(f).every(function (k) {
    if (!f[k](r[k])) return false;
    out[k] = Array.isArray(r[k]) ? r[k].slice() : r[k];
    return true;
  });
  return ok ? out : null;
}

/* Strict: valid, and nothing present that is not a field. What the server accepts. */
function exact(r) {
  var c = clean(r);
  return !!c && Object.keys(r).length === Object.keys(c).length;
}

/* The class of an error, never its message: messages carry paths, config and Slack text. */
function errorClass(e) {
  var n = e && e.constructor && e.constructor.name;
  return ERRORS.indexOf(n) > -1 && n !== 'Other' ? n : 'Other';
}

/* Code locations inside this repo, relative to it. Everything else — node internals, the
 * reader's home directory, anything that is not one of our files — is dropped. */
function frames(stack) {
  var out = [];
  String(stack || '').split('\n').forEach(function (line) {
    var m = line.replace(/\\/g, '/').match(/(?:^|\/)((?:src\/|tools\/)?[a-z-]+\.js):(\d+):\d+\)?\s*$/);
    if (m && out.length < 3 && WHERE.test(m[1] + ':' + m[2])) out.push(m[1] + ':' + m[2]);
  });
  return out;
}

/* On is a record written by `report.js --consent`, never a flag someone can flip back. */
function consent(cfg) {
  var d = cfg && cfg.diagnostics;
  return d && typeof d === 'object' && UUID.test(d.install) &&
    typeof d.salt === 'string' && d.salt.length >= 32 && DAY.test(String(d.consentedAt || '').slice(0, 10))
    ? d : null;
}

var api = {
  ENDPOINT: ENDPOINT, KINDS: KINDS, STAGES: STAGES, ERRORS: ERRORS, SIGNALS: SIGNALS,
  clean: clean, exact: exact, errorClass: errorClass, frames: frames, consent: consent
};
if (typeof module !== 'undefined') module.exports = api;
