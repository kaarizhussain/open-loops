/* Reports waiting to be sent, on disk next to the config.
 *
 * No network here — this only queues and discards. tools/report.js does the sending,
 * so the runner stays what SKILL.md says it is: local code with no network calls.
 *
 * Nothing is queued without a consent record, and anything queued under an earlier
 * consent is discarded rather than sent: turning diagnostics off and on again gets a new
 * install id, and an entry carries the id it was queued under.
 */
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var cp = require('child_process');
var D = require('./diagnostics.js');
var { writeAtomic } = require('./busy.js');

var MAX = 20, MAX_AGE_DAYS = 14, MAX_TRIES = 7;

function files(dir) {
  return { outbox: path.join(dir, 'reports-outbox.json'), log: path.join(dir, 'reports-sent.log') };
}

function read(dir) {
  try {
    var x = JSON.parse(fs.readFileSync(files(dir).outbox, 'utf8'));
    return Array.isArray(x) ? x : [];
  } catch (e) { return []; }
}

function write(dir, entries) {
  var f = files(dir).outbox;
  if (entries.length) writeAtomic(f, JSON.stringify(entries, null, 2) + '\n');
  else if (fs.existsSync(f)) fs.unlinkSync(f);
}

function log(dir, line) {
  fs.appendFileSync(files(dir).log, new Date().toISOString() + '  ' + line + '\n');
}

function version() {
  try {
    return cp.execFileSync('git', ['-C', path.join(__dirname, '..'), 'rev-parse', 'HEAD'],
      { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().slice(0, 7);
  } catch (e) { return 'unknown'; }
}

function os() {
  return ['win32', 'darwin', 'linux'].indexOf(process.platform) > -1 ? process.platform : 'other';
}

// Salted, so an id cannot be matched against a guess at the sentence or the Slack thread.
function reportId(c, parts) {
  return crypto.createHmac('sha256', c.salt).update(parts.join('|')).digest('hex').slice(0, 16);
}

/* Drops what may no longer be sent: everything when diagnostics are off, and otherwise
 * entries from an earlier consent, too old, tried too often, or over the cap. */
function prune(dir, cfg, now) {
  var entries = read(dir);
  if (!entries.length) return entries;
  var c = D.consent(cfg);
  if (!c) {
    write(dir, []);
    log(dir, 'discarded ' + entries.length + ' unsent report' + (entries.length === 1 ? '' : 's') +
      ' — diagnostics off');
    return [];
  }
  var oldest = new Date((now || Date.now()) - MAX_AGE_DAYS * 864e5).toISOString();
  var keep = entries.filter(function (e) {
    return e && e.report && e.report.install === c.install && D.clean(e.report) &&
      e.queuedAt >= oldest && (e.tries || 0) < MAX_TRIES;
  }).slice(-MAX);
  if (keep.length < entries.length) {
    log(dir, 'discarded ' + (entries.length - keep.length) + ' unsent (earlier consent, expired or undeliverable)');
    write(dir, keep);
  }
  return keep;
}

/* Queue one report. `fields` holds the kind and its own fields; `idParts` decide what
 * counts as the same event, so it is reported once. Returns the report, or null. */
function queue(dir, cfg, fields, idParts, date) {
  var c = D.consent(cfg);
  if (!c) return null;
  var r = {
    schema: 1, install: c.install, id: reportId(c, [fields.kind].concat(idParts)),
    kind: fields.kind, version: version(), host: c.host === 'codex' ? 'codex' : 'claude',
    node: parseInt(process.versions.node, 10), os: os(), date: date
  };
  Object.keys(fields).forEach(function (k) { if (k !== 'kind') r[k] = fields[k]; });
  r = D.clean(r);
  if (!r) return null;
  var entries = prune(dir, cfg);
  if (entries.some(function (e) { return e.report.id === r.id; })) return r;
  entries.push({ report: r, queuedAt: new Date().toISOString(), tries: 0 });
  write(dir, entries.slice(-MAX));
  return r;
}

module.exports = { files: files, read: read, write: write, log: log, prune: prune, queue: queue,
                   reportId: reportId, version: version, MAX: MAX, MAX_TRIES: MAX_TRIES };
