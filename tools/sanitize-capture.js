#!/usr/bin/env node
/* Turn a real connector capture into a fixture that can be committed.
 *
 *   node tools/sanitize-capture.js --you <email> --self <slack user id> --out <dir> <file>...
 *
 * Replaces identifiers and nothing else: email addresses, Slack ids, and the display
 * names the connector prints on its banners. Message text, timestamps, ordering, thread
 * roots and the connector's own formatting are left byte-for-byte, because the whole
 * value of a replay fixture is that it is what Slack actually sent.
 *
 * Deterministic. One mapping is built across every file given before anything is
 * replaced, so an identifier becomes the same placeholder everywhere it appears. The
 * reader is pinned to the placeholders the rest of the tests use — you@example.com,
 * U0EXAMPLE001, Alex Rivera — so a replay reads with the same identity as every other
 * fixture. Everyone else is numbered in order of first appearance.
 *
 * The mapping is printed, never written: it is the one thing here holding the real
 * identifiers. Exits non-zero if any of them survives into the output.
 */
var fs = require('fs');
var path = require('path');
// The detector's own idea of who is on which side, so placeholders can preserve it.
var side = require(path.join(__dirname, '..', 'src', 'loops.js')).side;

var argv = process.argv.slice(2);
var opt = function (k) {
  var i = argv.indexOf('--' + k);
  return i > -1 ? argv.splice(i, 2)[1] : null;
};
var you = (opt('you') || '').toLowerCase(), self = opt('self'), out = opt('out');
// Display names that are already invented — test personas — and carry meaning in the text.
var keep = (opt('keep') || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
var files = argv;
if (!you || !self || !out || !files.length) {
  console.error('usage: node tools/sanitize-capture.js --you <email> --self <slack user id> --out <dir> [--keep "Name A,Name B"] <file>...');
  process.exit(2);
}

var texts = files.map(function (f) { return fs.readFileSync(f, 'utf8'); });
var all = texts.join('\n');

var map = {};
var count = { U: 1 };                       // U0EXAMPLE001 is already the reader
var nextOf = function (kind) { count[kind] = (count[kind] || 0) + 1; return count[kind]; };
var pad = function (n) { return ('00' + n).slice(-3); };

map[you] = 'you@example.com';
map[self] = 'U0EXAMPLE001';

// Display names come from the connector's own banners — the one place a name is structural.
var NAME = /(?:=== Message from |^From: )(.+?)(?= <| \()/gm, m;
while ((m = NAME.exec(all))) {
  var name = m[1].trim();
  if (map[name] || keep.indexOf(name) > -1) continue;
  var end = all.indexOf('\n', m.index);
  var line = all.slice(m.index, end < 0 ? undefined : end);
  map[name] = line.indexOf('(' + self + ')') > -1 ? 'Alex Rivera' : 'Person ' + nextOf('name');
}

/* Addresses keep their sides. Everything used to become @example.com — the reader's own
 * placeholder domain — so a sanitized capture moved every other participant onto the
 * reader's side and erased exactly the structure a multi-person fixture exists to test.
 * Each side now gets one placeholder domain: the reader's side is example.com, a
 * colleague stays on it, two people at one company share a domain, and a consumer
 * address — its own side — gets a domain of its own. */
var sideDomain = {};
sideDomain[side(you)] = 'example.com';
(all.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).forEach(function (e) {
  var k = e.toLowerCase();
  if (map[k]) return;
  var s = side(k);
  if (!sideDomain[s]) sideDomain[s] = 'org' + nextOf('org') + '.example';
  map[k] = 'person' + nextOf('email') + '@' + sideDomain[s];
});

// A Slack id is an uppercase prefix plus at least one digit, so an all-caps word never is.
(all.match(/\b[UWBCDG](?=[A-Z0-9]*\d)[A-Z0-9]{8,12}\b/g) || []).forEach(function (id) {
  if (!map[id]) map[id] = id[0] + '0EXAMPLE' + pad(nextOf(id[0]));
});

/* One pass over one alternation, longest key first and bounded on both sides — so a
   placeholder is never replaced a second time, and a short name cannot eat the inside
   of a longer word. */
var lower = {};
Object.keys(map).forEach(function (k) { lower[k.toLowerCase()] = map[k]; });
var esc = function (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
var keys = Object.keys(map).sort(function (a, b) { return b.length - a.length; });
var RX = new RegExp('(?<![A-Za-z0-9])(?:' + keys.map(esc).join('|') + ')(?![A-Za-z0-9])', 'gi');

fs.mkdirSync(out, { recursive: true });
var leaked = {};
texts.forEach(function (t, i) {
  var s = t.replace(RX, function (hit) { return lower[hit.toLowerCase()]; });
  // Bounded like the replacement, or a person called "Sam" reads as leaked into "same".
  keys.forEach(function (k) {
    if (new RegExp('(?<![A-Za-z0-9])' + esc(k) + '(?![A-Za-z0-9])', 'i').test(s)) leaked[k] = 1;
  });
  fs.writeFileSync(path.join(out, path.basename(files[i])), s);
});

console.log('mapping (printed only, never written):');
keys.forEach(function (k) { console.log('  ' + k + '  ->  ' + map[k]); });
if (Object.keys(leaked).length) {
  console.error('LEAKED into the output: ' + Object.keys(leaked).join(', '));
  process.exit(1);
}
console.log('wrote ' + files.length + ' file(s) to ' + out);
