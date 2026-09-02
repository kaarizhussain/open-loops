/* Runs every suite there is.
 *
 * `npm test` used to be `node test.js` — one suite out of ten. That is worse than
 * having no test script, because it goes green while nine suites are never executed,
 * and the person running it has no way to tell. It drifted that way for the ordinary
 * reason: suites got added and the script did not. So this finds them rather than
 * listing them, and the next one to be added is picked up without anybody remembering.
 *
 * Keeps going after a failure. Which suite broke is useful; whether the others also
 * broke is what tells you if it was one bug or a shared one. */
var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var ROOT = path.join(__dirname, '..');

var suites = fs.readdirSync(__dirname)
  .filter(function (f) { return /^test.*\.js$/.test(f) && f !== 'run.js'; })
  .sort()
  .map(function (f) { return path.join(__dirname, f); });

var failed = [];
suites.forEach(function (file) {
  var r = cp.spawnSync(process.execPath, [file], { stdio: 'inherit', cwd: ROOT });
  if (r.status !== 0) failed.push(path.relative(ROOT, file));
});

console.log('');
if (failed.length) {
  console.log(failed.length + ' of ' + suites.length + ' suites failed:');
  failed.forEach(function (f) { console.log('  ' + f); });
  process.exit(1);
}
console.log('all ' + suites.length + ' suites passed');
