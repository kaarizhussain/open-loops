/* The demo page is a build artifact that is committed, because GitHub Pages has to serve
 * something. Which means it can drift from the engine it was built from, silently — and
 * it did. index.html shipped a detector older than src/loops.js for as long as it took
 * to notice by accident, and nothing anywhere said so.
 *
 * That drift is worse than most stale files, because the demo is the page most people
 * see and the one nobody thinks to re-check. It is also invisible in review: the diff
 * that breaks it is a change to src/, and index.html not appearing in that diff is
 * exactly the symptom rather than a sign of it being fine.
 *
 * Compares the inlined source against the file it came from, extracted the way build.js
 * extracts it. Failing here means: run `node build.js` and commit the result. */
var assert = require('assert');
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
/* Line endings, because git rewrites them on checkout and the two files need not have
   been written in the same pass. A guard that fails for a reason nobody caused is one
   that gets deleted rather than fixed. */
var lf = function (s) { return s.replace(/\r\n/g, '\n'); };

var index = lf(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'));

['loops.js', 'fixture.js'].forEach(function (f) {
  var src = lf(fs.readFileSync(path.join(ROOT, 'src', f), 'utf8'))
    .replace(/if \(typeof module[\s\S]*$/, '');
  assert.ok(index.indexOf(src) > -1,
    'index.html was built from an older ' + f + ' — run `node build.js` and commit it');
});

/* And that it is a whole page rather than a half-written one, since the build writes in
   place and a crash mid-write leaves something that still parses as HTML. */
assert.ok(/<\/html>\s*$/.test(index), 'index.html is truncated — rebuild it');
assert.strictEqual(index.match(/__[A-Z_]+__/), null, 'index.html has an unsubstituted placeholder');

console.log('build: OK');
