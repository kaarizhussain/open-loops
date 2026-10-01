#!/usr/bin/env node
/* Rejected items: what is hidden, and putting one back.
 *
 *   node tools/corrections.js --list --config <config>
 *        what has been rejected (a reference, when, how old, and the sentence if the ledger keeps sentences) and where each restore request stands
 *   node tools/corrections.js --restore <reference> --config <config>
 *   node tools/corrections.js --restore-item <n> --digest <digest ref> --config <config>
 *        asks for an item back: by its reference, or by its number in a digest (the way when the ledger keeps no sentences)
 *
 * This writes ONE file, restores.json beside the config, and never the ledger: the digest is the ledger's only writer. It reads the ledger to
 * check what you asked for and to say where a request stands. A request is only a request until the digest has applied it, and says so.
 * `--now YYYY-MM-DDTHH:MM` (local time) is for tests.
 */
var fs = require('fs');
var path = require('path');
var R = require('../src/restore.js');
var L = require('../src/ledger.js');
var S = require('../src/status.js');
var { fileStore } = require('../src/store.js');
var { settings } = require('../src/config.js');

var MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
var md = function (d) { return d && /^\d{4}-\d{2}-\d{2}/.test(d) ? MONTH[+d.slice(5, 7) - 1] + ' ' + (+d.slice(8, 10)) : 'a date that was not recorded'; };
var dayOf = function (iso) { var d = new Date(iso); return isNaN(d) ? null : d.toISOString().slice(0, 10); };

var WHY = { not_tracked: 'no longer tracked', not_rejected: 'not currently rejected', ambiguous_prefix: 'more than one reference starts that way', unknown_ref: 'not a reference this ledger knows' };

function main(argv) {
  var flag = function (k) { var i = argv.indexOf('--' + k); return i > -1 && argv[i + 1] !== undefined && argv[i + 1].indexOf('--') !== 0 ? argv[i + 1] : null; };
  var has = function (k) { return argv.indexOf('--' + k) > -1; };
  var configPath = flag('config') || 'openloops.config.json', dir = path.dirname(path.resolve(configPath));
  var now = S.parseNow(flag('now') || '');
  var cfg = settings(fs, configPath, { you: 'report@localhost' });
  var store = fileStore(cfg.ledger, { noSalt: true }), st = store.restoreState();   // read only: nothing here flushes
  var rows = store.readLedger();

  if (has('restore') || has('restore-item')) {
    var target = has('restore') ? { ref: String(flag('restore') || '').toLowerCase() } : { digest: { ref: String(flag('digest') || '').toLowerCase(), n: Number(flag('restore-item')) } };
    var shape = target.ref ? R.REF.test(target.ref) : R.DIGEST_REF.test(target.digest.ref) && Number.isInteger(target.digest.n) && target.digest.n >= 1 && target.digest.n <= 999;
    if (!shape) throw new Error(target.ref !== undefined ? '--restore needs a reference from --list (4 to 16 hex characters). Nothing was queued.' :
      '--restore-item needs an item number and --digest <the four-character reference in that digest\'s header>. Nothing was queued.');
    var res = R.resolve(Object.assign({ id: '00000000' }, target), st, store);
    if (res.refuse) {
      return 'NOT QUEUED — ' + res.ref + ' ' + ({ unknown_ref: 'is not a reference this ledger knows (a digest this old is not remembered, or the number is past its list). Ask for the list of rejected items.',
        ambiguous_prefix: 'is the start of more than one reference. Use more characters.' }[res.refuse]) + ' Nothing was queued.';
    }
    var q = R.addRequest(dir, target, st.log, now, function (t) { var x = R.resolve(Object.assign({ id: '00000000' }, t), st, store); return x.key || null; });
    return (q.existing ? 'Restore already requested for ' + res.ref + ' (request ' + q.id + '). ' : 'Restore requested for ' + res.ref + ' (request ' + q.id + '). ') +
      'It is queued: your next digest will say whether it came back.';
  }

  if (has('list')) {
    var byKey = {};
    rows.forEach(function (r) { byKey[r[L.COL.key]] = r; });
    var out = [], hidden = rows.filter(function (r) { return r[L.COL.verdict] === 'x'; }), unnamed = 0;
    hidden.forEach(function (r) {
      var ref = R.refOf(st.refs, r[L.COL.key]);
      if (!ref) { unnamed++; return; }
      var text = r[L.COL.what];
      out.push('  ' + ref + '  rejection recorded ' + md(st.refs[ref].on) + ' · first seen ' + md(r[L.COL.first_seen]) + ' · ' + (text ? '"' + String(text).slice(0, 80) + '"' : r[L.COL.type] + ' (the ledger keeps no sentences)'));
    });
    var lines = ['HIDDEN AS WRONG — ' + out.length];
    if (out.length) lines = lines.concat(out);
    if (unnamed) lines.push('  ' + unnamed + (unnamed === 1 ? ' more was' : ' more were') + ' rejected before references existed: they get one at the next digest.');
    var reqs = R.loadRequests(dir);
    if (reqs.damaged) lines.push('', 'restores.json could not be read, so requests cannot be listed or queued until it is fixed.');
    if (reqs.requests.length) {
      lines.push('', 'RESTORE REQUESTS');
      reqs.requests.forEach(function (r) {
        var e = st.log[r.id], what = r.ref || 'item ' + r.digest.n + ' of digest ' + r.digest.ref;
        var state = !e ? 'pending: waiting for the next digest to process it' :
          e.state === 'refused' ? 'refused: ' + (WHY[e.reason] || e.reason) :
          (e.superseded || (byKey[e.key] && byKey[e.key][L.COL.verdict] === 'x')) ? 'applied ' + md(e.on) + ', then you rejected it again, so it stays hidden' : 'applied ' + md(e.on);
        lines.push('  ' + r.id + '  ' + what + '  requested ' + md(dayOf(r.requestedAt)) + '  ' + state);
      });
    }
    return lines.join('\n');
  }
  throw new Error('usage: see the top of tools/corrections.js');
}

if (require.main === module) {
  try { console.log(main(process.argv.slice(2))); }
  catch (e) { console.error('corrections: ' + e.message); process.exit(e && e.exitCode || 1); }
}

module.exports = { main: main };
