var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var { parseMessages, readConversation } = require('../src/slack-json');
var { parseChannel } = require('../src/slack');
var { main } = require('../slack-run');
var { install } = require('../tools/install-codex');

var ts = '1790000000.000001';
var raw = { ts: ts, user: 'U123', text: 'I will send the contract tomorrow.' };
var opts = { channel: '#deals', self: 'me@example.com', selfUid: 'U123',
  users: { U123: { email: 'me@example.com', name: 'Alex' } } };
function banner(m) {
  return '=== Message from Alex <me@example.com> (U123) at now ===\nMessage TS: ' + m.ts + '\n' + m.text;
}
assert.deepStrictEqual(parseMessages([raw], opts), parseChannel(banner(raw), opts),
  'structured and Claude input produce the same normalized message');
assert.strictEqual(parseMessages([raw], { self:'me@example.com', selfUid:'U123' })[0].from, 'me@example.com');
assert.strictEqual(parseMessages([raw], {})[0].from, 'u123@slack.local');
assert.throws(function () { parseMessages([{ ...raw, ts: 1790000000 }]); }, /Invalid Slack message/);
assert.throws(function () { parseMessages([{ ...raw, text: undefined }]); }, /Invalid Slack message/);
assert.throws(function () { readConversation({text: banner(raw), messages:[raw]}, opts); }, /not both/);
assert.throws(function () { parseMessages([{...raw, thread_ts:'1790000001.000001'}], {threadId:ts}); }, /different thread/);
assert.strictEqual(parseMessages([{...raw, text:'', files:[{name:'contract.pdf'}]}], opts)[0].attach, true);
assert.strictEqual(parseMessages([{...raw, text:'', files:[{name:'contract.pdf'}]}], opts)[0].body, 'contract.pdf');
assert.strictEqual(parseMessages([{...raw, thread_ts:ts}], opts)[0].stream, false);
assert.strictEqual(parseMessages([{...raw, reply_count:2}], opts)[0].hasThread, true);
assert.deepStrictEqual(parseMessages([{...raw,ts:'1790000000.000003'}, raw], opts).map(m=>m.id), ['1790000000.000001','1790000000.000003']);

var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openloops-codex-'));
var inputPath = path.join(dir, 'input.json'), ledger = path.join(dir, 'ledger.json');
var config = path.join(dir, 'config.json');
fs.writeFileSync(config, JSON.stringify({you:'me@example.com',selfUid:'U123',selfDm:'D123',channels:{include:['#deals']}}));
function run(input, dry) {
  fs.writeFileSync(inputPath, JSON.stringify(input));
  return main([inputPath,'--config',config,'--ledger',ledger].concat(dry ? ['--dry'] : []));
}
var data = { today:'2026-09-21',spotCheck:0, users:opts.users, conversations:[{channel:'#deals',messages:[raw]}] };
var original = { ...data, conversations:[{channel:'#deals',text:banner(raw)}] };
assert.strictEqual(run(data,true),run(original,true),'both hosts produce the same full digest');
assert.ok(!fs.existsSync(ledger),'preview does not write the ledger');
var posted = run(data);   // the digest as posted, reference and all
var before = fs.readFileSync(ledger,'utf8');
assert.throws(function () { run({...data,conversations:[{channel:'#deals',messages:[{...raw,ts:'broken'}]}]}); });
assert.strictEqual(fs.readFileSync(ledger,'utf8'),before,'malformed structured input never changes saved state');
var excluded = {...data,conversations:data.conversations.concat({channel:'#private',messages:[{...raw,ts:'broken'}]})};
assert.doesNotThrow(function () { run(excluded,true); }, 'scope checked before parsing excluded channels');
var digest = {ts:'1790020000.000001',user:'U123',text:posted.split('\n')[0]};
var correction = {ts:'1790020001.000001',user:'U123',thread_ts:digest.ts,text:'1'};
var corrected = run({...data,today:'2026-09-22',dmThread:{root:digest.ts,messages:[digest,correction]}});
assert.ok(/0 open/.test(corrected),'structured self-DM thread corrections suppress the recorded item');

var reply={ts:'1790000010.000001',user:'U123',thread_ts:ts,text:'Contract attached.'};
var threaded={...data,threads:[{channel:'#deals',root:ts,messages:[raw,reply]}]};
assert.ok(/0 open/.test(run(threaded,true)),'thread deliveries close the promise without duplicating its root');

var target = path.join(dir,'installed');
install(target);
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(target,'local.json'),'utf8')).checkout,path.resolve(__dirname,'..'));
assert.ok(fs.existsSync(path.join(target,'references','codex.md')),'installed skill includes host workflow');
fs.writeFileSync(path.join(target,'keep.txt'),'user customization');
assert.throws(function () { install(target); },/already exists/);
assert.strictEqual(fs.readFileSync(path.join(target,'keep.txt'),'utf8'),'user customization');
console.log('slack-json and Codex installation: OK');
