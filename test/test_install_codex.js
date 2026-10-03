/* An update that fails must leave the installed skill working (codex-debug-review, 2026-10-02, finding 7). The old copy used
 * to move aside before the new one was copied, so a failed copy (a full disk) left only the backup and no active skill.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var { install } = require('../tools/install-codex.js');

var d = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-install-')), target = path.join(d, 'open-loops');
var live = function () { var f = path.join(target, 'SKILL.md'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '(no installed skill)'; };
var others = function () { return fs.readdirSync(d).filter(function (f) { return f !== 'open-loops'; }); };

install(target);
assert.ok(fs.existsSync(path.join(target, 'local.json')), 'a fresh install');
fs.writeFileSync(path.join(target, 'SKILL.md'), 'the installed version');

// The copy fails: the installed skill is untouched, and nothing half-made is left beside it.
var cpSync = fs.cpSync;
fs.cpSync = function () { var e = new Error('no space left on device'); e.code = 'ENOSPC'; throw e; };
assert.throws(function () { install(target, { update: true }); }, /no space/);
fs.cpSync = cpSync;
assert.strictEqual(live(), 'the installed version', 'a failed copy leaves the installed skill in place');
assert.deepStrictEqual(others(), [], 'and no partial copy or backup');

// The swap fails: the old skill is put back.
var renameSync = fs.renameSync, calls = 0;
fs.renameSync = function (a, b) { if (++calls === 2) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return renameSync(a, b); };
assert.throws(function () { install(target, { update: true }); }, /busy/);
fs.renameSync = renameSync;
assert.strictEqual(live(), 'the installed version', 'a failed swap restores the installed skill');
assert.deepStrictEqual(others(), [], 'and cleans up');

// A working update replaces it and keeps the old copy beside it.
install(target, { update: true });
assert.notStrictEqual(live(), 'the installed version', 'an update installs the new version');
assert.ok(others().length === 1 && /^open-loops\.bak-/.test(others()[0]), 'keeping one backup');
assert.throws(function () { install(target); }, /already exists/, 'without --update an existing install is refused');

fs.rmSync(d, { recursive: true, force: true });
console.log('Codex installation updates: OK');
