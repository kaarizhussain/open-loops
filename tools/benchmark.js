/* Run the detector over real correspondence and report what it does.
 *
 *   node tools/benchmark.js <path-to-maildir> [--lookback 21] [--sample 8]
 *
 * What this is: every accuracy number this project has ever printed came from a fixture
 * written by the same person who wrote the regexes, or from seventeen sentences typed
 * into a test Slack workspace. That measures whether the code does what its author
 * imagined, which is the least informative test available. The Enron corpus is a
 * quarter of a million emails between real people conducting real business, none of
 * whom knew a detector would ever read them.
 *
 * What this is NOT: ground truth. The corpus has no labels, so this cannot compute
 * precision on its own. What it gives is the two things that were genuinely unknown —
 * whether the detector survives real text, and at what RATE it fires — plus a sample
 * small enough for a person to read and judge. A rate is not accuracy, but a detector
 * firing on 40% of messages is wrong in a way no amount of judging individual items
 * would have shown, and one firing on 0.1% is useless in a way precision would call
 * perfect.
 */
var fs = require('fs');
var path = require('path');
var E = require('./enron.js');
var { detectLoops, LABEL } = require('../src/loops.js');

var args = process.argv.slice(2);
var root = args[0];
var opt = function (name, dflt) {
  var i = args.indexOf('--' + name);
  return i > -1 && args[i + 1] ? +args[i + 1] : dflt;
};
if (!root || !fs.existsSync(root)) {
  console.error('usage: node tools/benchmark.js <path-to-maildir> [--lookback 21] [--sample 8]');
  console.error('get the corpus: curl -O https://www.cs.cmu.edu/~enron/enron_mail_20150507.tar.gz');
  process.exit(1);
}
var LOOKBACK = opt('lookback', 21);
var SAMPLE = opt('sample', 8);

function addDays(iso, n) {
  var d = new Date(iso.slice(0, 10) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

var boxes = fs.readdirSync(root, { withFileTypes: true })
  .filter(function (e) { return e.isDirectory(); })
  .map(function (e) { return e.name; });

var totals = { boxes: 0, read: 0, items: 0, byType: {}, crashes: [] };
var examples = [];

boxes.forEach(function (name) {
  var all = E.mailbox(path.join(root, name));
  var exec = E.owner(all);
  if (!exec || all.length < 20) return;

  /* One window per mailbox, ending on its last day of activity — the same bounded read
     the real thing does, rather than the whole two-year archive at once. */
  var today = all[all.length - 1].date.slice(0, 10);
  var from = addDays(today, -LOOKBACK);
  var window = all.filter(function (m) { return m.date.slice(0, 10) >= from; });
  if (!window.length) return;

  var r;
  try {
    r = detectLoops(window, [], { exec: exec, today: today });
  } catch (err) {
    totals.crashes.push(name + ': ' + err.message);
    return;
  }

  totals.boxes++;
  totals.read += window.length;
  totals.items += r.open.length;
  r.open.forEach(function (l) {
    totals.byType[l.type] = (totals.byType[l.type] || 0) + 1;
    examples.push({ box: name, type: l.type, what: l.what, due: l.due, who: l.who });
  });

  console.log(pad(name, 14) + pad(exec, 32) +
    pad(window.length + ' msgs', 11) + pad(r.open.length + ' open', 10) + today);
});

function pad(s, n) { s = String(s); return s.length >= n ? s.slice(0, n - 1) + ' ' : s + ' '.repeat(n - s.length); }

console.log('');
console.log('=== ' + totals.boxes + ' mailboxes, ' + totals.read + ' messages in a ' +
            LOOKBACK + '-day window each ===');
console.log('');
console.log('  ' + totals.items + ' items, ' +
            (totals.read ? (totals.items / totals.read * 100).toFixed(1) : '0') +
            ' per 100 messages read');
Object.keys(totals.byType).sort(function (a, b) { return totals.byType[b] - totals.byType[a]; })
  .forEach(function (t) {
    console.log('    ' + pad((LABEL && LABEL[t]) || t, 20) + totals.byType[t]);
  });
if (totals.crashes.length) {
  console.log('');
  console.log('  CRASHED on ' + totals.crashes.length + ':');
  totals.crashes.forEach(function (c) { console.log('    ' + c); });
}

/* Spread the sample across types rather than taking the first N, or it is entirely
   whichever signal happens to be loudest and says nothing about the others. */
console.log('');
console.log('=== a sample to judge by hand — is each of these a real commitment? ===');
var byType = {};
examples.forEach(function (e) { (byType[e.type] = byType[e.type] || []).push(e); });
var picked = [];
Object.keys(byType).forEach(function (t) {
  var step = Math.max(1, Math.floor(byType[t].length / Math.max(1, Math.ceil(SAMPLE / Object.keys(byType).length))));
  for (var i = 0; i < byType[t].length && picked.length < SAMPLE * 2; i += step) picked.push(byType[t][i]);
});
picked.slice(0, SAMPLE).forEach(function (e, i) {
  console.log('');
  console.log(' ' + (i + 1) + '. [' + ((LABEL && LABEL[e.type]) || e.type) + ']' +
              (e.due ? ' due ' + e.due : '') + '  ' + e.box);
  console.log('    ' + String(e.what).replace(/\s+/g, ' ').slice(0, 150));
});
