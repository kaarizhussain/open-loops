/* Build a labelling sheet from the top of real digests.
 *
 *   node tools/evalset.js <path-to-maildir> [--per 8] [--out eval.md]
 *
 * Why the TOP of each mailbox rather than a random sample: the aggregate hit rate and
 * the quality of the first eight items moved in OPPOSITE directions when this was
 * measured — a parse-based filter cut the rate by a quarter while making the top of the
 * list worse. The rate is not what anybody reads. The first eight items are the digest,
 * so they are what has to be graded.
 *
 * A rubric, not a vibe. Whoever labels this — a person, a model, several of each — the
 * three questions are fixed, so two labellers disagreeing means they disagree about an
 * item rather than about what the task was.
 *
 * Emits two files: a .md to hand to a labeller, and a .json to join the verdicts back
 * against. Item ids are stable across runs so a re-run does not orphan existing labels.
 *
 * The corpus is public and legally cleared for research, but these are real people's
 * words. Nothing here should be republished as anybody's example of bad practice.
 */
var fs = require('fs');
var path = require('path');
var E = require('./enron.js');
var { detectLoops, LABEL } = require('../src/loops.js');
var D = require('../src/digest.js');

var args = process.argv.slice(2);
var root = args[0];
var opt = function (n, d) { var i = args.indexOf('--' + n); return i > -1 && args[i + 1] ? args[i + 1] : d; };
if (!root || !fs.existsSync(root)) {
  console.error('usage: node tools/evalset.js <path-to-maildir> [--per 8] [--out eval.md]');
  process.exit(1);
}
var PER = +opt('per', 8);
var OUT = opt('out', 'eval.md');

function addDays(iso, n) {
  var d = new Date(iso.slice(0, 10) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

var RUBRIC = [
  '# Open Loops — labelling sheet',
  '',
  'Each item below was surfaced at the TOP of a real digest, from a real mailbox. Mark',
  'each one KEEP or DROP.',
  '',
  'It is a KEEP only if all three are true:',
  '',
  '1. **Deliverable** — it produces an artifact, a decision, or a state change. Something',
  '   exists afterwards that did not before.',
  '2. **Human agency** — it cannot resolve itself by the passage of time. An out-of-office',
  '   notice, a stated availability, a meeting that will simply happen: those are DROP.',
  '3. **Unambiguously actionable** — a specific party owes a specific thing. Vague posture,',
  '   polite hedging and broadcast chatter are DROP.',
  '',
  'If two of three hold, it is still DROP. The question this benchmark exists to answer is',
  'whether an assistant would chase it, not whether it is grammatically a promise.',
  '',
  'Write the verdict after `verdict:` on each item. Leave a short reason where it was a',
  'close call — the close calls are where two labellers will differ, and knowing which',
  'items those are matters more than the totals.',
  '',
  '---',
  ''
];

var lines = RUBRIC.slice();
var records = [];
var n = 0;

fs.readdirSync(root, { withFileTypes: true })
  .filter(function (e) { return e.isDirectory(); })
  .forEach(function (name) {
    var dir = name.name;
    var all = E.mailbox(path.join(root, dir));
    var exec = E.owner(all);
    if (!exec || all.length < 20) return;
    var today = all[all.length - 1].date.slice(0, 10);
    var win = all.filter(function (m) { return m.date.slice(0, 10) >= addDays(today, -21); });
    if (!win.length) return;
    var byId = {};
    win.forEach(function (m) { byId[m.id] = m; });

    var r;
    try { r = detectLoops(win, [], { exec: exec, today: today }); } catch (e) { return; }
    var top = D.actionList(r.open, PER);
    if (!top.length) return;

    lines.push('## ' + dir + '  —  ' + exec + '  (' + win.length + ' messages, ' +
               r.open.length + ' items, showing top ' + top.length + ')');
    lines.push('');

    top.forEach(function (l) {
      n++;
      var src = byId[l.msgId] || {};
      var id = dir + '-' + n;
      records.push({
        id: id, mailbox: dir, exec: exec, type: l.type,
        due: l.due || null, who: l.who || null,
        subject: src.subject || null, from: src.from || null,
        what: String(l.what || '').replace(/\s+/g, ' ').trim(),
        verdict: null
      });
      lines.push('**' + id + '**  ·  ' + (LABEL[l.type] || l.type) +
                 (l.due ? '  ·  due ' + l.due : '') );
      lines.push('- from: ' + (src.from || '?') + (src.subject ? '   subject: ' + String(src.subject).slice(0, 70) : ''));
      lines.push('- text: ' + String(l.what || '').replace(/\s+/g, ' ').slice(0, 220));
      lines.push('- verdict: ');
      lines.push('');
    });
  });

lines.push('---');
lines.push('');
lines.push('Total: ' + n + ' items.');

fs.writeFileSync(OUT, lines.join('\n'));
fs.writeFileSync(OUT.replace(/\.md$/, '') + '.json', JSON.stringify(records, null, 1));
console.log('wrote ' + OUT + ' and ' + OUT.replace(/\.md$/, '') + '.json  —  ' + n + ' items');
