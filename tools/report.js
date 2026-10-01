#!/usr/bin/env node
/* Diagnostic reports: consent, queue, send.
 *
 *   node tools/report.js --consent --config <config>                  show the consent question
 *   node tools/report.js --consent --yes [--host codex] --config <c>   they said yes: reports on (new id)
 *   node tools/report.js --send [--failed <stage>] --config <config>  send what is queued
 *   node tools/report.js --show --config <config>                     what is queued, what went
 *   node tools/report.js --example <n> --config <config>              draft an example to review
 *   node tools/report.js --send-example --config <config>             send the reviewed draft
 *
 * The only file here that uses the network, and only to the report server. Nothing is
 * sent without a consent record in the config; `"diagnostics": false` discards the queue.
 * Metadata reports go without asking each time — that is what the reader agreed to. An
 * example carries a sentence, so it goes only as a draft file the reader has read.
 */
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var D = require('../src/diagnostics.js');
var outbox = require('../src/outbox.js');
var { loadConfig } = require('../src/config.js');
var { fileStore } = require('../src/store.js');
var L = require('../src/ledger.js');

var TIMEOUT_MS = 5000;

// Tests point this at a local server, or set it empty to mean "no server" — never the real one.
function endpoint() {
  return 'OPEN_LOOPS_REPORT_URL' in process.env ? process.env.OPEN_LOOPS_REPORT_URL : D.ENDPOINT;
}

async function post(route, body) {
  var res = await fetch(endpoint().replace(/\/$/, '') + route, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  return res.status;
}

/* One attempt per queued report. Delivered: logged and removed. Refused as invalid or
 * over this install's cap: dropped, since sending it again cannot help. Anything else — no
 * network, timeout, the server busy (503, its global limits) — stays for the next run
 * until it ages out. */
async function send(dir, cfg) {
  var entries = outbox.prune(dir, cfg);
  if (!entries.length) return { sent: 0, kept: 0, dropped: 0 };
  if (!endpoint()) return { sent: 0, kept: entries.length, dropped: 0, note: 'no report server set yet' };
  var kept = [], sent = 0, dropped = 0;
  for (var e of entries) {
    var r = D.clean(e.report), status = 0;
    try { status = await post('/report', r); } catch (err) { status = 0; }
    if (status >= 200 && status < 300) { sent++; outbox.log(dir, 'sent ' + JSON.stringify(r)); }
    else if (status === 400 || status === 413 || status === 429) {
      dropped++; outbox.log(dir, 'dropped (server said ' + status + ') ' + r.id);
    } else { e.tries = (e.tries || 0) + 1; kept.push(e); }
  }
  outbox.write(dir, kept);
  return { sent: sent, kept: kept.length, dropped: dropped };
}

/* The question, exactly as SKILL.md words it — one copy, so this cannot drift from it. */
function consentText() {
  var md = fs.readFileSync(path.join(__dirname, '..', 'skills', 'open-loops', 'SKILL.md'), 'utf8');
  var out = [], on = false;
  for (var l of md.split(String.fromCharCode(10))) {
    l = l.replace(String.fromCharCode(13), '');
    if (l.indexOf('> **Diagnostic reports') === 0) on = true;
    if (on) out.push(l === '>' ? '' : l.slice(2));
    if (on && l.indexOf('**Send diagnostic reports?**') > -1) break;
  }
  return out.join(String.fromCharCode(10));
}

function consent(configPath, host) {
  var raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  raw.diagnostics = {
    install: crypto.randomUUID(), salt: crypto.randomBytes(32).toString('hex'),
    consentedAt: new Date().toISOString(), host: host === 'codex' ? 'codex' : 'claude'
  };
  fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n');
  return raw.diagnostics.install;
}

// Emails and Slack ids become placeholders. Names and anything confidential do not — the
// reader reads the draft, and may edit it, before anything is sent.
function scrub(text) {
  return String(text)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 'person@example.com')
    .replace(/<@[A-Z0-9]+(\|[^>]*)?>/g, '@someone')
    .replace(/\b[UCDGW](?=[A-Z0-9]*\d)[A-Z0-9]{8,}\b/g, 'SLACK_ID');   // ids have a digit; words don't
}

function draftExample(dir, cfg, ledgerPath, n) {
  var c = D.consent(cfg);
  if (!c) return { error: 'Diagnostic reports are off, so there is nowhere to send an example.' };
  var store = fileStore(ledgerPath);
  var date = store.digestDates().sort().pop();
  var key = date && store.recallDigest(date)[n - 1];
  if (!key) return { error: 'No item ' + n + ' in the latest digest.' };
  var row = store.readLedger().filter(function (r) { return r[L.COL.key] === key; })[0];
  var text = row && L.cell(row[L.COL.what]);
  if (!text) return { error: 'No sentence was kept for item ' + n + ' ("storeText": false keeps none).' };
  var ex = { schema: 1, install: c.install, id: outbox.reportId(c, ['example', key]), kind: 'example',
             version: outbox.version(), date: new Date().toISOString().slice(0, 10),
             signal: key.split('|')[0], first_seen: L.cell(row[L.COL.first_seen]),
             text: scrub(text).slice(0, 800) };
  if (!D.exact(ex)) return { error: 'Item ' + n + ' cannot be sent as an example.' };
  fs.writeFileSync(path.join(dir, 'example-draft.json'), JSON.stringify(ex, null, 2) + '\n');
  return { example: ex };
}

async function sendExample(dir, cfg) {
  var f = path.join(dir, 'example-draft.json');
  var ex = JSON.parse(fs.readFileSync(f, 'utf8'));
  var c = D.consent(cfg);
  if (!c || ex.install !== c.install || !D.exact(ex)) return 'Not sent: the draft is invalid or from an earlier consent.';
  if (!endpoint()) return 'Not sent: no report server set yet.';
  var status = await post('/example', ex).catch(function () { return 0; });
  if (status >= 200 && status < 300) {
    fs.unlinkSync(f);
    outbox.log(dir, 'sent example ' + ex.id);
    return 'Sent.';
  }
  return 'Not sent (server said ' + (status || 'nothing') + '). The draft is still there.';
}

async function main(argv) {
  var flag = function (k) { var i = argv.indexOf('--' + k); return i > -1 ? argv[i + 1] : null; };
  var configPath = flag('config') || 'openloops.config.json';
  var dir = path.dirname(path.resolve(configPath));
  if (argv.indexOf('--consent') > -1) {
    // Asking and recording are separate steps, so nothing is turned on by the command alone.
    if (argv.indexOf('--yes') < 0) return consentText() + '\n\n(Nothing recorded. On a yes: add --yes.)';
    return 'Diagnostic reports on. Install id ' + consent(configPath, flag('host')) + '.';
  }
  var cfg = loadConfig(fs, configPath);
  if (argv.indexOf('--show') > -1) {
    var log = fs.existsSync(outbox.files(dir).log) ? fs.readFileSync(outbox.files(dir).log, 'utf8') : '';
    return 'Queued:\n' + JSON.stringify(outbox.prune(dir, cfg).map(function (e) { return e.report; }), null, 2) +
      '\n\nLog:\n' + (log.trim().split('\n').slice(-20).join('\n') || '(empty)');
  }
  if (flag('example')) {
    var d = draftExample(dir, cfg, flag('ledger') || cfg.ledger || 'ledger.json', parseInt(flag('example'), 10));
    return d.error || 'This would be sent, exactly as written (' + path.join(dir, 'example-draft.json') + '):\n\n' +
      '  signal     ' + d.example.signal + ' · first seen ' + d.example.first_seen + '\n' +
      '  sentence   "' + d.example.text + '"';
  }
  if (argv.indexOf('--send-example') > -1) return sendExample(dir, cfg);
  if (argv.indexOf('--send') > -1) {
    var stage = flag('failed');
    if (stage) {
      if (D.STAGES.indexOf(stage) < 0) { var bad = new Error('--failed takes one of: ' + D.STAGES.join(', ')); bad.usage = true; throw bad; }
      var today = new Date().toISOString().slice(0, 10);
      outbox.queue(dir, cfg, { kind: 'run_failed', stage: stage, error: 'Other', where: [] },
        [today, stage, 'Other', '-'], today);
    }
    var r = await send(dir, cfg);
    return 'reports: ' + r.sent + ' sent, ' + r.kept + ' queued, ' + r.dropped + ' dropped' +
      (r.note ? ' (' + r.note + ')' : '');
  }
  throw new Error('usage: see the top of tools/report.js');
}

if (require.main === module) {
  // Never fails the run it follows: a report that cannot go is not the reader's problem.
  main(process.argv.slice(2)).then(function (out) { console.log(out); },
    function (e) { console.error('report: ' + e.message); if (e && e.usage) process.exitCode = 1; });    // a refused argument is a mistake in the call; a report that cannot go still never fails the run
}

module.exports = { consentText: consentText, main: main, send: send, consent: consent, scrub: scrub, draftExample: draftExample };
