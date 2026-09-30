#!/usr/bin/env node
/* Midday alerts: which run this is, consent, and confirming an alert was posted.
 *
 *   node tools/alerts.js --which --config <config>     DIGEST | CHECK <slot> <date> | SKIP — why
 *   node tools/alerts.js --confirm --config <config>   the alert is in the DM: remember it
 *   node tools/alerts.js --consent --config <config>   show the consent question, record nothing
 *   node tools/alerts.js --consent --yes --config <c>  they said yes: alerts on
 *   node tools/alerts.js --decline --config <config>   they said no: never offer again
 *   node tools/alerts.js --status --config <config>
 *
 * No network, and it reads no Slack: `--which` decides from the clock and two local files, so a
 * run that has nothing to do fetches nothing. `--now YYYY-MM-DDTHH:MM` (local time) is for tests.
 */
var fs = require('fs');
var path = require('path');
var A = require('../src/alerts.js');
var { loadConfig } = require('../src/config.js');
var { fileStore } = require('../src/store.js');

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

function ledgerPath(cfg) { return path.resolve(cfg.ledger || 'ledger.json'); }

function main(argv) {
  var flag = function (k) { var i = argv.indexOf('--' + k); return i > -1 ? argv[i + 1] : null; };
  var configPath = flag('config') || 'openloops.config.json';
  var dir = path.dirname(path.resolve(configPath));
  var has = function (k) { return argv.indexOf('--' + k) > -1; };

  if (has('consent')) {
    if (!has('yes')) return consentText() + '\n\n(Nothing recorded. On a yes: add --yes.)';
    writeConfig(configPath, { delivery: 'dm', consentedAt: new Date().toISOString(), times: A.DEFAULT_TIMES });
    return 'Midday alerts on, at ' + A.DEFAULT_TIMES.join(', ') + ' on weekdays. Checks run once the scheduled task is ' +
      'updated to run at those times (SKILL.md, "Offering midday alerts").';
  }
  if (has('decline')) {
    writeConfig(configPath, { delivery: 'off', offeredAt: new Date().toISOString() });
    return 'Recorded: alerts stay off, and they will not be offered again.';
  }

  var cfg = loadConfig(fs, configPath);
  if (has('status')) {
    var c = A.consent(cfg), s = A.load(dir);
    return c ? 'Alerts on at ' + c.times.join(', ') + ' (since ' + c.consentedAt.slice(0, 10) + '). Baseline: ' +
      (s.baseline ? 'digest of ' + s.baseline.date : 'none yet') + '.'
      : 'Alerts off' + (cfg.alerts && cfg.alerts.offeredAt ? ' (offered ' + cfg.alerts.offeredAt.slice(0, 10) + ', declined).' : '.');
  }
  if (has('confirm')) {
    return A.confirm(dir) ? 'Confirmed: the alert is recorded, and its slot is done.' : 'Nothing pending.';
  }
  if (has('which')) {
    var dates = [];
    try { dates = fileStore(ledgerPath(cfg)).digestDates(); } catch (e) { dates = []; }
    var d = A.decide(cfg, A.parseNow(flag('now') || ''), dir, dates);
    return d.run === 'CHECK' ? 'CHECK ' + d.slot + ' ' + d.date + ' — ' + d.reason : d.run + ' — ' + d.reason;
  }
  throw new Error('usage: see the top of tools/alerts.js');
}

if (require.main === module) {
  try { console.log(main(process.argv.slice(2))); }
  catch (e) { console.error('alerts: ' + e.message); process.exit(1); }
}

module.exports = { main: main, consentText: consentText };
