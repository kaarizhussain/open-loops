#!/usr/bin/env node
/* Installs the skill, not credentials or a schedule. Keep this checkout in place:
 * local.json points the installed workflow at the code that was actually tested.
 *
 *   node tools/install-codex.js [--update] [--dest <skill-directory>] [--backup-dir <directory>]
 *
 * The directory Codex scans for skills must hold only live skills: every copy of this one carries the same name, so a
 * backup or a half-built replacement left beside it is a second, outdated skill that Codex can pick. The old copy and the
 * staging copy therefore live in a backup directory outside it (by default `skill-backups`, next to the `skills`
 * directory), never beside the install.
 */
var fs = require('fs');
var path = require('path');
var os = require('os');

var inside = function (child, parent) {
  var rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

function install(destination, opts) {
  opts = opts || {};
  var root = path.resolve(__dirname, '..');
  var target = path.resolve(destination || path.join(
    process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'skills', 'open-loops'));
  var backups = path.resolve(opts.backupDir || path.join(path.dirname(path.dirname(target)), 'skill-backups'));
  // Refused before anything is touched: these would damage the source, or plant a second SKILL.md inside another skill.
  if (inside(target, path.join(root, 'skills'))) throw new Error('Refusing to install into this checkout\'s own skills directory: ' + target + '.');
  if (inside(backups, target) || inside(target, backups)) throw new Error('The backup directory and the skill directory must be separate: ' + backups + '.');
  if (fs.existsSync(path.join(path.dirname(target), 'SKILL.md'))) throw new Error('Refusing to install inside another skill (' + path.dirname(target) + ' has a SKILL.md).');
  var exists = fs.existsSync(target);
  if (exists && !fs.statSync(target).isDirectory()) throw new Error('Skill path exists and is not a directory: ' + target + '. Nothing was changed.');
  if (exists && !opts.update) {
    throw new Error('Skill directory already exists: ' + target + '. Run with --update to replace it, keeping the old copy in ' + backups + '.');
  }
  /* Instructions and runner stay one version: replace the copy, never merge into it. The replacement is built complete in
   * the backup directory, and the live copy moves there only then — so a copy that fails (a full disk) leaves the installed
   * skill alone. A swap that fails puts the old one back, and whatever was staged is removed on every way out. */
  var stamp = new Date().toISOString().replace(/[:.]/g, '-');
  var fresh = path.join(backups, 'staging-' + stamp), old = path.join(backups, 'open-loops-' + stamp);
  var movedOld = false;
  try {
    fs.mkdirSync(backups, { recursive: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(path.join(root, 'skills', 'open-loops'), fresh, { recursive: true, errorOnExist: true, force: false });
    fs.writeFileSync(path.join(fresh, 'local.json'), JSON.stringify({ checkout: root }, null, 2) + '\n');
    if (exists) { fs.renameSync(target, old); movedOld = true; }
    fs.renameSync(fresh, target);
    movedOld = false;    // the new copy is live: the old one is now the backup
  } catch (e) {
    if (movedOld) { try { fs.renameSync(old, target); } catch (restoreFailed) { e.message += ' (the previous copy is at ' + old + ': move it back to ' + target + ')'; } }
    throw e;
  } finally {
    fs.rmSync(fresh, { recursive: true, force: true });
  }
  return { target: target, backup: exists ? old : null };
}

if (require.main === module) {
  try {
    var args = process.argv.slice(2), update = args.indexOf('--update') > -1, opts = {}, dest;
    if (update) args.splice(args.indexOf('--update'), 1);
    opts.update = update;
    while (args.length) {
      var flag = args.shift();
      if (flag === '--dest' && args.length) dest = args.shift();
      else if (flag === '--backup-dir' && args.length) opts.backupDir = args.shift();
      else throw new Error('usage: node tools/install-codex.js [--update] [--dest <skill-directory>] [--backup-dir <directory>]');
    }
    var done = install(dest, opts);
    console.log((update ? 'Updated' : 'Installed') + ' Open Loops skill at ' + done.target + (done.backup ? ' (previous copy kept at ' + done.backup + ')' : ''));
    console.log('Ask Codex: Use $open-loops to set up my Slack digest. Restart Codex if the skill is not listed.');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}

module.exports = { install: install };
