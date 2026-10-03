#!/usr/bin/env node
/* Installs the skill, not credentials or a schedule. Keep this checkout in place:
 * local.json points the installed workflow at the code that was actually tested.
 */
var fs = require('fs');
var path = require('path');
var os = require('os');

function install(destination, opts) {
  var root = path.resolve(__dirname, '..');
  var target = path.resolve(destination || path.join(
    process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'skills', 'open-loops'));
  var exists = fs.existsSync(target);
  if (exists && !(opts && opts.update)) {
    throw new Error('Skill directory already exists: ' + target + '. Run with --update to replace it, keeping the old copy beside it.');
  }
  /* Instructions and runner stay one version: replace the copy, never merge into it. The replacement is built complete
   * beside the live copy, and the live one moves aside only then — it used to move first, so a copy that failed (a full
   * disk) left no installed skill at all. A swap that fails puts the old one back. */
  var stamp = new Date().toISOString().replace(/[:.]/g, '-');
  var fresh = target + '.new-' + stamp, backup = target + '.bak-' + stamp;
  try {
    fs.cpSync(path.join(root, 'skills', 'open-loops'), fresh, { recursive: true, errorOnExist: true, force: false });
    fs.writeFileSync(path.join(fresh, 'local.json'), JSON.stringify({ checkout: root }, null, 2) + '\n');
  } catch (e) { fs.rmSync(fresh, { recursive: true, force: true }); throw e; }
  if (exists) fs.renameSync(target, backup);
  try { fs.renameSync(fresh, target); }
  catch (e) {
    if (exists) fs.renameSync(backup, target);
    fs.rmSync(fresh, { recursive: true, force: true });
    throw e;
  }
  return target;
}

if (require.main === module) {
  try {
    var args = process.argv.slice(2), update = args.indexOf('--update') > -1;
    if (update) args.splice(args.indexOf('--update'), 1);
    if (args.length && (args.length !== 2 || args[0] !== '--dest')) {
      throw new Error('usage: node tools/install-codex.js [--update] [--dest <skill-directory>]');
    }
    console.log((update ? 'Updated' : 'Installed') + ' Open Loops skill at ' + install(args[1], { update: update }));
    console.log('Ask Codex: Use $open-loops to set up my Slack digest. Restart Codex if the skill is not listed.');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}

module.exports = { install: install };
