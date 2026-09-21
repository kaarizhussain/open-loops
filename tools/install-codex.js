#!/usr/bin/env node
/* Installs the skill, not credentials or a schedule. Keep this checkout in place:
 * local.json points the installed workflow at the code that was actually tested.
 */
var fs = require('fs');
var path = require('path');
var os = require('os');

function install(destination) {
  var root = path.resolve(__dirname, '..');
  var target = path.resolve(destination || path.join(
    process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'skills', 'open-loops'));
  if (fs.existsSync(target)) throw new Error('Skill directory already exists: ' + target + '. Keep or back it up before reinstalling.');
  fs.cpSync(path.join(root, 'skills', 'open-loops'), target, { recursive: true, errorOnExist: true, force: false });
  fs.writeFileSync(path.join(target, 'local.json'), JSON.stringify({ checkout: root }, null, 2) + '\n');
  return target;
}

if (require.main === module) {
  try {
    var args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--dest')) {
      throw new Error('usage: node tools/install-codex.js [--dest <skill-directory>]');
    }
    console.log('Installed Open Loops skill at ' + install(args[1]));
    console.log('Ask Codex: Use $open-loops to set up my Slack digest. Restart Codex if the skill is not listed.');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}

module.exports = { install: install };
