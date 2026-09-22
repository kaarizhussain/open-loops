#!/usr/bin/env node
/* Prove each coverage regression test detects removal of the behavior it protects.
 * Every mutant runs in a fresh temporary copy; the working tree is never modified. */
var assert = require('assert');
var cp = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

var root = path.resolve(__dirname,'..');
var mutations = [
  ['page containers','src/slack-json.js',
    "if (Object.prototype.hasOwnProperty.call(conversation, 'pages')) {",
    "if (false && Object.prototype.hasOwnProperty.call(conversation, 'pages')) {"],
  ['metadata cannot come from message text','src/slack-coverage.js',
    'var pages = source.pages;',
    'var pages = [{ pagination_info: source.pages && source.pages[0] && source.pages[0].text }];'],
  ['requested oldest bounds coverage','src/slack-coverage.js',
    'if (source.oldest != null) {','if (false && source.oldest != null) {'],
  ['complete fallback','src/slack-coverage.js',
    '} else if (source.complete === true) {','} else if (false && source.complete === true) {'],
  ['confirmed empty channels','src/digest.js',
    'blind: !b.messages.length && read.threads > 0 && read.confirmedEmpty !== read.threads',
    'blind: !b.messages.length && read.threads > 0'],
  ['source isolation','slack-run.js',
    "return sourceCoverage[key].state === 'complete';","return true;"],
  ['explicit closure during partial coverage','src/ledger.js',
    "(opts.closedKeys || []).indexOf(cell(r[COL.key])) === -1",
    'true'],
  ['failed thread coverage','src/slack-coverage.js',
    "state = 'partial'; reason = 'the fetch was marked partial or failed';",
    "state = 'complete'; reason = '';"],
  ['aging before uncertainty','src/ledger.js',
    "if (windowStart && /^\\d{4}-\\d{2}-\\d{2}$/.test(said || '') && said < windowStart) {",
    "if (false && windowStart && /^\\d{4}-\\d{2}-\\d{2}$/.test(said || '') && said < windowStart) {"],
  ['pruning during uncertainty','slack-run.js',
    'L.pruneLedger(rows, today, cfg.keepLedgerDays);',
    'if (!ledger.unknown.length) L.pruneLedger(rows, today, cfg.keepLedgerDays);']
];

mutations.forEach(function (mutation) {
  var temp=fs.mkdtempSync(path.join(os.tmpdir(),'openloops-mutant-'));
  try {
    fs.cpSync(root,temp,{recursive:true,filter:function (src) {
      return path.basename(src) !== '.git' && path.basename(src) !== 'node_modules';
    }});
    var file=path.join(temp,mutation[1]);
    var source=fs.readFileSync(file,'utf8');
    assert.ok(source.includes(mutation[2]),'mutation target moved: '+mutation[0]);
    fs.writeFileSync(file,source.replace(mutation[2],mutation[3]));
    var result=cp.spawnSync(process.execPath,['test/test_coverage.js'],{cwd:temp,encoding:'utf8'});
    assert.notStrictEqual(result.status,0,'coverage suite survived removal of '+mutation[0]);
    console.log('caught: '+mutation[0]);
  } finally {
    fs.rmSync(temp,{recursive:true,force:true});
  }
});

console.log('all '+mutations.length+' coverage mutations were caught');
