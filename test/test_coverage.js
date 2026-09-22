var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var C = require('../src/slack-coverage');
var L = require('../src/ledger');
var { readConversation } = require('../src/slack-json');
var { main } = require('../slack-run');

var MORE = 'There are more messages available. To view the next page, use cursor: `next`\n';
var DONE = 'There are no more messages available.\n';
var THREAD_DONE = 'There are no more messages in this thread.\n';
var cut = '2026-08-31';
function epoch(date, hour) {
  return String(Date.parse(date + 'T' + String(hour || 0).padStart(2, '0') + ':00:00Z') / 1000) + '.000001';
}
function bound(date) { return String(Date.parse(date + 'T00:00:00Z') / 1000) + '.000000'; }

// Connector metadata is authoritative; message text can never impersonate it.
assert.strictEqual(C.coverage({pages:[{text:'There are no more messages available.'}]},cut,0).state,'unknown');
assert.strictEqual(C.coverage({oldest:bound(cut),pages:[{text:'',pagination_info:DONE}]},cut,0).state,'complete');
assert.strictEqual(C.coverage({oldest:bound('2026-09-01'),pages:[{text:'',pagination_info:DONE}]},cut,0).state,'partial');
assert.strictEqual(C.coverage({oldest:bound(cut),complete:true,pages:[{text:'',pagination_info:MORE}]},cut,0).state,'partial');
assert.strictEqual(C.coverage({pages:[{text:'',pagination_info:'{"has_more":true,"next_cursor":"abc"}'}]},cut,0).state,'partial');
assert.strictEqual(C.coverage({pages:[{text:'',pagination_info:'{"has_more":false,"next_cursor":""}'}]},cut,0).state,'complete');
assert.strictEqual(C.coverage({pages:[{text:'',pagination_info:'{"next_cursor":"abc"}'}]},cut,0).state,'partial');
assert.strictEqual(C.coverage({pages:[{text:'',pagination_info:'{"next_cursor":null}'}]},cut,0).state,'complete');
assert.strictEqual(C.coverage({complete:true,messages:[]},cut,0).state,'complete');
assert.strictEqual(C.coverage({pages:[{text:'',pagination_info:DONE}]},cut,0).state,'complete');
var easternStart=String(Date.parse(cut+'T04:00:00Z')/1000)+'.000000';
assert.strictEqual(C.coverage({oldest:easternStart,pages:[{text:'',pagination_info:DONE}]},cut,-240).state,'complete');
assert.strictEqual(C.coverage({oldest:String(Number(easternStart)+1),pages:[{text:'',pagination_info:DONE}]},cut,-240).state,'partial');

var parsed = readConversation({pages:[
  {messages:[{ts:epoch('2026-09-20',10),user:'U1',text:'first'}],pagination_info:MORE},
  {messages:[{ts:epoch('2026-09-20',11),user:'U1',text:'second'}],pagination_info:DONE}
]},{channel:'#a'});
assert.deepStrictEqual(parsed.map(function (m) { return m.body; }),['first','second']);

var dir = fs.mkdtempSync(path.join(os.tmpdir(),'openloops-coverage-'));
var inputPath = path.join(dir,'input.json');
var configPath = path.join(dir,'config.json');
fs.writeFileSync(configPath,JSON.stringify({
  you:'ea@example.com',selfUid:'UEA',selfDm:'DEA',useCalendar:false,spotCheck:0,
  channels:{include:['#a','#b']},lookbackDays:21,keepLedgerDays:90
}));
var users={UEA:{email:'ea@example.com'},U1:{email:'alice@example.com'}};
function message(ts,text,user,extra) { return Object.assign({ts:ts,user:user||'U1',text:text},extra||{}); }
function source(channel,today,messages,info,extra) {
  var start = new Date(Date.parse(today+'T00:00:00Z')-21*864e5).toISOString().slice(0,10);
  return Object.assign({channel:channel,oldest:bound(start),pages:[{messages:messages,pagination_info:info}]},extra||{});
}
function run(name,data,extraConfig) {
  var ledger=path.join(dir,name+'.json');
  if (extraConfig) fs.writeFileSync(configPath,JSON.stringify(Object.assign({
    you:'ea@example.com',selfUid:'UEA',selfDm:'DEA',useCalendar:false,spotCheck:0,
    channels:{include:['#a','#b']},lookbackDays:21,keepLedgerDays:90
  },extraConfig)));
  fs.writeFileSync(inputPath,JSON.stringify(data));
  return {text:main([inputPath,'--config',configPath,'--ledger',ledger]),ledger:ledger};
}
function rerun(ledger,data) {
  fs.writeFileSync(inputPath,JSON.stringify(data));
  return main([inputPath,'--config',configPath,'--ledger',ledger]);
}

var today='2026-09-20';
var promiseA=message(epoch(today,10),'I will send the Alpha contract tomorrow.');
var promiseB=message(epoch(today,11),'I will send the Beta contract tomorrow.');

// A fully paged quiet channel and a confirmed empty channel are both complete.
var quiet=run('quiet',{today:today,users:users,conversations:[source('#a',today,[promiseA],DONE)]});
assert.ok(!quiet.text.includes('INCOMPLETE'));
var empty=run('empty',{today:today,users:users,conversations:[source('#a',today,[],DONE)]});
assert.ok(/0 open/.test(empty.text));
assert.ok(!/READ NOTHING|NOTHING READ|INCOMPLETE/.test(empty.text));

// Missing coverage affects only its source; the complete source resolves normally.
var isolated=run('isolated',{today:today,users:users,conversations:[
  source('#a',today,[promiseA],DONE),source('#b',today,[promiseB],DONE)
]});
var next='2026-09-21';
var isolatedText=rerun(isolated.ledger,{today:next,users:users,conversations:[
  {channel:'#a',pages:[{messages:[]}]},source('#b',next,[],DONE)
]});
assert.ok(/1 cleared/.test(isolatedText));
assert.ok(/1 not verified/.test(isolatedText));
assert.ok(isolatedText.includes('Alpha contract') && isolatedText.includes('Beta contract'));

// Explicit closure evidence wins even when older pages remain unfetched.
var closing=run('closing',{today:today,users:users,conversations:[source('#a',today,[promiseA],DONE)]});
var delivered=message(epoch(next,12),'Alpha contract attached.');
var closingText=rerun(closing.ledger,{today:next,users:users,conversations:[
  source('#a',next,[promiseA,delivered],MORE)
]});
assert.ok(/CLOSED ITSELF/.test(closingText));
assert.ok(!closingText.includes('NOT VERIFIED'));

// Failed thread reads are named and preserve commitments found in that thread.
var root=message(epoch(today,9),'Contract discussion.','U1',{reply_count:1});
var threadPromise=message(epoch(today,10),'I will send the thread contract tomorrow.','U1',{thread_ts:root.ts});
var threaded=run('threaded',{today:today,users:users,
  conversations:[source('#a',today,[root],DONE)],
  threads:[{channel:'#a',root:root.ts,pages:[{messages:[root,threadPromise],pagination_info:THREAD_DONE}]}]
});
var threadFailed=rerun(threaded.ledger,{today:next,users:users,
  conversations:[source('#a',next,[root],DONE)],
  threads:[{channel:'#a',root:root.ts,complete:false,pages:[{messages:[]}]}]
});
assert.ok(threadFailed.includes('INCOMPLETE — #a thread '+root.ts));
assert.ok(/thread had replies that were not read/.test(threadFailed));
assert.ok(threadFailed.includes('NOT VERIFIED'));

// Aging is decided before source uncertainty, and it is never called completion.
var oldKey='owed_by_us|#a|2026-08-01|abcdef01';
var oldRows=[[oldKey,'2026-08-01','2026-08-01','','owed_by_us','Alice','Old promise','']];
var aged=L.mergeLedger(oldRows,[],'2026-09-21',{windowStart:'2026-08-31',availableThreads:[]});
assert.strictEqual(aged.aged.length,1);
assert.strictEqual(aged.unknown.length,0);
assert.strictEqual(aged.gone.length,0);

// Retention still runs during uncertainty, and deletion is never rendered as CLEARED.
var pruning=run('pruning',{today:today,users:users,conversations:[source('#a',today,[promiseA],DONE)]},{keepLedgerDays:2});
var prunedText=rerun(pruning.ledger,{today:'2026-09-23',users:users,conversations:[{channel:'#a',pages:[{messages:[]}]}]});
assert.ok(!/CLEARED SINCE THE LAST RUN|NOT VERIFIED/.test(prunedText));
assert.strictEqual(JSON.parse(fs.readFileSync(pruning.ledger)).rows.length,0);
var wrong=[[oldKey,'2026-08-01','2026-08-01','','owed_by_us','Alice','Old promise','wrong']];
assert.strictEqual(L.pruneLedger(wrong,'2026-09-21',2),1,'stale wrong rows retain the existing pruning policy');

fs.rmSync(dir,{recursive:true,force:true});
console.log('coverage: OK');
