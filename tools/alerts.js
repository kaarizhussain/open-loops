#!/usr/bin/env node
/* Midday alerts: which run this is, consent, and confirming an alert was posted.
 *
 *   node tools/alerts.js --which --config <config>     CHECK <slot> <date> | SKIP — why | OFF — why
 *   node tools/alerts.js --baseline --ref <ref> --config <config>   the digest is posted and read back: its baseline
 *   node tools/alerts.js --confirm --id <alert id> --config <config>   that alert is in the DM: remember it
 *   node tools/alerts.js --consent --config <config>   show the consent question, record nothing
 *   node tools/alerts.js --consent --yes --config <c>  they said yes: alerts on
 *   node tools/alerts.js --decline --config <config>   they said no: never offer again
 *   node tools/alerts.js --off --config <config>       alerts were on and are now off
 *   node tools/alerts.js --status --config <config>
 *
 * No network, and it reads no Slack: `--which` decides from the clock and one local file, so a
 * run that has nothing to do fetches nothing. It is for the checks task, except `--baseline`, which
 * is the evening digest task's, once its digest is posted and read back. `--now YYYY-MM-DDTHH:MM` (local time) is for tests.
 */
var fs = require('fs');
var path = require('path');
var A = require('../src/alerts.js');
var { loadConfig } = require('../src/config.js');

/* The question, exactly as SKILL.md words it — one copy, so this cannot drift from it. */
function consentText() {
  var md = fs.readFileSync(path.join(__dirname, '..', 'skills', 'open-loops', 'SKILL.md'), 'utf8');
  var out = [], on = false;
  for (var l of md.split(String.fromCharCode(10))) {
    l = l.replace(String.fromCharCode(13), '');
    if (l.indexOf('> **Midday alerts') === 0) on = true;
    if (on) out.push(l === '>' ? '' : l.slice(2));
    if (on && l.indexOf('**Turn on midday alerts?**') > -1) break;
  }
  return out.join(String.fromCharCode(10));
}

function writeConfig(configPath, alerts) {
  var raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  raw.alerts = alerts;
  fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n');
}

function main(argv) {
  var flag = function (k) { var i = argv.indexOf('--' + k); return i > -1 ? argv[i + 1] : null; };
  var configPath = flag('config') || 'openloops.config.json';
  var dir = path.dirname(path.resolve(configPath));
  var has = function (k) { return argv.indexOf('--' + k) > -1; };

  if (has('consent')) {
    if (!has('yes')) return consentText() + '\n\n(Nothing recorded. On a yes: add --yes.)';
    writeConfig(configPath, { delivery: 'dm', consentedAt: new Date().toISOString(), times: A.DEFAULT_TIMES });
    return 'Midday alerts on, at ' + A.DEFAULT_TIMES.join(', ') + ' on weekdays. Checks run once the "Open Loops checks" ' +
      'scheduled task exists (SKILL.md, "Offering midday alerts").';
  }
  if (has('decline')) {
    writeConfig(configPath, { delivery: 'off', offeredAt: new Date().toISOString() });
    return 'Recorded: alerts stay off, and they will not be offered again.';
  }
  if (has('off')) {
    var was = loadConfig(fs, configPath).alerts || {}, when = new Date().toISOString();
    writeConfig(configPath, { delivery: 'off', offeredAt: was.offeredAt || was.consentedAt || when, offAt: when });
    return 'Alerts are off. Pause or delete the "Open Loops checks" scheduled task; the daily digest task is not affected.';
  }

  var cfg = loadConfig(fs, configPath);
  if (has('status')) {
    var c = A.consent(cfg), s = A.load(dir);
    return c ? 'Alerts on at ' + c.times.join(', ') + ' (since ' + c.consentedAt.slice(0, 10) + '). Baseline: ' +
      (s.baseline ? 'digest of ' + s.baseline.date : 'none yet') + '.'
      : A.consentProblem(cfg) ? 'Alerts are off: the "alerts" setting in your config cannot be used — ' + A.consentProblem(cfg) + '.'
      : 'Alerts off' + (cfg.alerts && cfg.alerts.offAt ? ' (turned off ' + cfg.alerts.offAt.slice(0, 10) + ').'
        : cfg.alerts && cfg.alerts.offeredAt ? ' (offered ' + cfg.alerts.offeredAt.slice(0, 10) + ', declined).' : '.');
  }
  if (has('baseline')) {
    var b = A.promoteBaseline(dir, flag('ref'));
    return b ? 'Baseline recorded for the digest of ' + b.date + '.'
      : 'Nothing staged for that ref: no baseline was written.';
  }
  if (has('confirm')) {
    var id = flag('id');
    if (!id) throw new Error('--confirm needs --id <alert id>, the one the check printed for the alert that was posted');
    return A.confirm(dir, undefined, { id: id })
      ? 'Confirmed: the alert is recorded, and its slot is done.' : 'Nothing pending.';
  }
  if (has('which')) {
    var d = A.decide(cfg, A.parseNow(flag('now') || ''), dir);
    return d.run === 'CHECK' ? 'CHECK ' + d.slot + ' ' + d.date + ' — ' + d.reason : d.run + ' — ' + d.reason;
  }
  throw new Error('usage: see the top of tools/alerts.js');
}

if (require.main === module) {
  try { console.log(main(process.argv.slice(2))); }
  catch (e) { console.error('alerts: ' + e.message); process.exit(e && e.exitCode || 1); }    // 3: a configuration that cannot be used, as in every other tool
}

module.exports = { main: main, consentText: consentText };
