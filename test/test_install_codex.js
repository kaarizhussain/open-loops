/* An update that fails must leave the installed skill working (codex-debug review 2026-10-02, finding 7), and — found again by the
 * adversarial review of 2026-10-05 — must never leave a second copy of the skill in the directory Codex scans: every copy carries
 * the same name, so a backup or a half-built replacement beside the install is an outdated duplicate Codex can pick.
 * So the old copy and the staging copy live in a separate backup directory, and every way out cleans the staging copy.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var { install } = require('../tools/install-codex.js');

var d = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-install-'));
var skills = path.join(d, 'skills'), target = path.join(skills, 'open-loops'), backups = path.join(d, 'skill-backups');
var opts = function (extra) { return Object.assign({ backupDir: backups }, extra); };
var live = function () { var f = path.join(target, 'SKILL.md'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '(no installed skill)'; };
var discoverable = function () { return fs.readdirSync(skills); };                       // what Codex scans
var skillFiles = function () {                                                            // every SKILL.md it could find, one level down
  return discoverable().filter(function (n) { return fs.existsSync(path.join(skills, n, 'SKILL.md')); });
};
var staged = function () { return fs.existsSync(backups) ? fs.readdirSync(backups).filter(function (n) { return /^staging-/.test(n); }) : []; };

install(target, opts());
assert.ok(fs.existsSync(path.join(target, 'local.json')), 'a fresh install');
assert.deepStrictEqual(skillFiles(), ['open-loops'], 'one skill is discoverable');
fs.writeFileSync(path.join(target, 'SKILL.md'), 'the installed version');

// The copy fails: the installed skill is untouched, and nothing is left in either directory.
var cpSync = fs.cpSync;
fs.cpSync = function () { var e = new Error('no space left on device'); e.code = 'ENOSPC'; throw e; };
assert.throws(function () { install(target, opts({ update: true })); }, /no space/);
fs.cpSync = cpSync;
assert.strictEqual(live(), 'the installed version', 'a failed copy leaves the installed skill in place');
assert.deepStrictEqual(discoverable(), ['open-loops'], 'and leaves nothing beside it');
assert.deepStrictEqual(staged(), [], 'or in the backup directory');

// The FIRST rename (live -> backup) fails: nothing was moved, and the staging copy is removed. (It used to be left beside the install.)
var renameSync = fs.renameSync;
fs.renameSync = function () { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); };
assert.throws(function () { install(target, opts({ update: true })); }, /busy/);
fs.renameSync = renameSync;
assert.strictEqual(live(), 'the installed version', 'a failed first rename leaves the installed skill in place');
assert.deepStrictEqual(discoverable(), ['open-loops'], 'with no staging copy beside it');
assert.deepStrictEqual(staged(), [], 'and none left behind');

// The SECOND rename (staging -> live) fails: the old skill is put back.
var calls = 0;
fs.renameSync = function (a, b) { if (++calls === 2) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return renameSync(a, b); };
assert.throws(function () { install(target, opts({ update: true })); }, /busy/);
fs.renameSync = renameSync;
assert.strictEqual(live(), 'the installed version', 'a failed swap restores the installed skill');
assert.deepStrictEqual(discoverable(), ['open-loops'], 'with nothing else in the skills directory');
assert.deepStrictEqual(staged(), [], 'and no staging copy');

// A working update: the new copy is live, the old one is in the backup directory, and nothing else is discoverable.
var done = install(target, opts({ update: true }));
assert.notStrictEqual(live(), 'the installed version', 'an update installs the new version');
assert.deepStrictEqual(discoverable(), ['open-loops'], 'a successful update leaves no backup beside the install');
assert.deepStrictEqual(skillFiles(), ['open-loops'], 'so exactly one skill named open-loops is discoverable');
assert.strictEqual(fs.readFileSync(path.join(done.backup, 'SKILL.md'), 'utf8'), 'the installed version', 'the old copy is kept in the backup directory');
assert.ok(path.relative(skills, done.backup).startsWith('..'), 'outside the skills directory');
assert.deepStrictEqual(staged(), [], 'with no staging copy left');
assert.throws(function () { install(target, opts()); }, /already exists/, 'without --update an existing install is refused');

// Destinations that would do damage are refused before anything is touched.
var src = path.join(__dirname, '..', 'skills', 'open-loops');
var before = fs.readdirSync(src).join();
assert.throws(function () { install(src, opts({ update: true })); }, /own skills directory/, 'not into the source tree');
assert.strictEqual(fs.readdirSync(src).join(), before, 'which is left as it was');
var file = path.join(skills, 'afile'); fs.writeFileSync(file, 'x');
assert.throws(function () { install(file, opts({ update: true })); }, /not a directory/, 'not over a file');
assert.strictEqual(fs.readFileSync(file, 'utf8'), 'x');
assert.throws(function () { install(path.join(target, 'nested'), opts()); }, /inside another skill/, 'not inside another skill');
assert.throws(function () { install(target, { update: true, backupDir: path.join(target, 'b') }); }, /separate/, 'and the backup directory is not inside the skill');

fs.rmSync(d, { recursive: true, force: true });
console.log('Codex installation updates: OK');
