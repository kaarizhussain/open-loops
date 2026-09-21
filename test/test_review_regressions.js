var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var E = require('../src/loops');
var L = require('../src/ledger');
var { main } = require('../slack-run');
var { fileStore } = require('../src/store');
var opts = {exec:'ea@example.com',today:'2026-09-21',principals:[{label:'Dana'}]};
function msg(from, body, date, stream) {
  return {id:date,from:from,body:body,date:date,threadId:'#work',subject:'#work',to:[],stream:stream !== false};
}
var promise=msg('alice@client.com','I will send the contract tomorrow.','2026-09-18T10:00');
function detect(reply, from) {
  return E.detectLoops([promise,msg(from || promise.from,reply,'2026-09-19T10:00')],[],opts);
}
assert.strictEqual(detect('Contract attached.','bob@other.com').open.length,1);
assert.strictEqual(detect('Contract attached.').closed.length,1);
['The contract is not signed yet.','I will send the signed contract tomorrow.',
 'The contract has not been uploaded.','Have you signed the contract?',
 'The contract should be signed tomorrow.'].forEach(function (s) {
  assert.ok(detect(s).open.some(l=>l.msgId===promise.id),s+' must not close the original promise');
});
assert.strictEqual(detect('Contract signed.').closed.length,1);
var dated=[msg('alice@client.com','The picnic is on October 15.','2026-09-18T10:00'),
 msg('ea@example.com','I will send the contract.','2026-09-19T10:00')];
assert.strictEqual(E.detectLoops(dated,[],opts).open[0].due,null);
dated[0]=msg('alice@client.com','Can you send the contract by Tuesday?','2026-09-19T09:00');
assert.strictEqual(E.detectLoops(dated,[],opts).open.find(l=>l.type==='owed_by_us').due,'2026-09-22');
dated.forEach(m=>m.stream=false);
dated[0].date='2026-09-18T10:00';
assert.strictEqual(E.detectLoops(dated,[],opts).open.find(l=>l.type==='owed_by_us').due,'2026-09-22',
  'real thread can inherit a request across days');

var dir=fs.mkdtempSync(path.join(os.tmpdir(),'openloops-review-fixes-'));
var input=path.join(dir,'input.json'),ledger=path.join(dir,'ledger.json');
var raw={ts:'1789725600.000001',user:'U123',text:'I will send the secret contract tomorrow.'};
var base={self:'ea@example.com',today:'2026-09-20',spotCheck:0,
 users:{U123:{email:'alice@client.com'}},conversations:[{channel:'#work',messages:[raw]}]};
function run(data,extra) {
  fs.writeFileSync(input,JSON.stringify(data));
  return main([input,'--ledger',ledger,'--config',path.join(dir,'absent.json')].concat(extra||[]));
}
run(base);
var initial=fs.readFileSync(ledger,'utf8');
[
 {conversations:[{channel:'#work',text:'connector failed'}]},
 {conversations:[{channel:'#work',complete:true,text:'connector failed'}]},
 {conversations:[]},
 {conversations:[{channel:'#work',complete:false,messages:[]}]},
 {conversations:[{channel:'#other',messages:[{...raw,text:'Hello.'}]}]}
].forEach(function (change) {
  fs.writeFileSync(ledger,initial);
  var text=run({...base,...change,today:'2026-09-21'});
  assert.ok(!text.includes('CLEARED SINCE THE LAST RUN'),JSON.stringify(change));
  assert.ok(text.includes('NOT VERIFIED'), 'missing commitments remain visible as unknown');
  assert.strictEqual(JSON.parse(fs.readFileSync(ledger)).rows[0][L.COL.gone_on],'');
});
// A failed thread fetch must not be counted as fetched just because it was supplied.
fs.writeFileSync(ledger,initial);
var threadBase={...base,conversations:[{channel:'#work',complete:true,messages:[{...raw,reply_count:1}]}],
 threads:[{channel:'#work',root:raw.ts,messages:[raw]}]};
run(threadBase);
var threadFailed=run({...threadBase,today:'2026-09-21',threads:[{channel:'#work',root:raw.ts,text:'fetch failed'}]});
assert.ok(!threadFailed.includes('CLEARED SINCE THE LAST RUN'));
assert.ok(threadFailed.includes('NOT VERIFIED'));
fs.writeFileSync(ledger,initial);
var real=run({...base,today:'2026-09-21',conversations:[{channel:'#work',messages:[raw,
 {...raw,ts:'1789812000.000001',text:'Secret contract attached.'}]}]});
assert.ok(real.includes('CLEARED SINCE THE LAST RUN'),'actual delivery still clears despite a short read window');

// A confirmed complete read can settle unanswered asks using a real reply.
var ask={...raw,text:'Can you confirm the contract today?'};
var askBase={...base,conversations:[{channel:'#work',complete:true,messages:[ask]}]};
run(askBase);
var answer={...raw,user:'U456',ts:'1789812000.000002',text:'The contract is confirmed.'};
var answered=run({...askBase,today:'2026-09-21',users:{...base.users,U456:{email:'ea@example.com'}},
 conversations:[{channel:'#work',complete:true,messages:[ask,answer]}]});
assert.ok(answered.includes('CLEARED SINCE THE LAST RUN'),'confirmed complete reads still settle answered requests');

// Unread calendars preserve event rows as unknown.
var meeting={id:'event1',summary:'Client call',start:{dateTime:'2026-09-21T10:00:00-04:00'},
 attendees:[{email:'ea@example.com'},{email:'alice@client.com'}]};
run({...base,events:{events:[meeting]}});
var noCalendar=run({...base,today:'2026-09-21',events:'calendar unavailable'});
assert.ok(noCalendar.includes('NOT VERIFIED'));
assert.strictEqual(JSON.parse(fs.readFileSync(ledger)).rows.find(r=>r[0]==='unprepped_meeting|event1')[L.COL.gone_on],'');

// Privacy transitions scrub every row, rejected rows, learned text and the rollback
// snapshot; the output remains live text, but the entire persisted state is text-free.
fs.writeFileSync(ledger,initial);
var store=fileStore(ledger);
store.remember([{phrase:'secret contract',count:4,since:'2026-09-20'}]);
var saved=fs.readFileSync(ledger,'utf8');
run({...base,today:'2026-09-21',storeText:false},['--dry']);
assert.strictEqual(fs.readFileSync(ledger,'utf8'),saved,'privacy preview must not change disk');
run({...base,today:'2026-09-21',storeText:false});
var clean=fs.readFileSync(ledger,'utf8');
assert.ok(!clean.includes('secret contract') && !clean.includes('alice@client.com'));
run({...base,today:'2026-09-21',storeText:false});
assert.ok(!fs.readFileSync(ledger,'utf8').includes('secret contract'),'same-day rerun cannot resurrect text');
var rows=JSON.parse(initial).rows;
rows[0][L.COL.verdict]='wrong';
var key=rows[0][L.COL.key];
L.mergeLedger(rows,[],base.today,{storeText:false});
assert.strictEqual(rows[0][L.COL.key],key);
assert.strictEqual(rows[0][L.COL.verdict],'wrong');
assert.strictEqual(rows[0][L.COL.what],'');
console.log('review regressions: OK');
