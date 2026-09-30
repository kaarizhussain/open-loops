/* The safety batch: the sanitizer never silently overwrites; malformed channel patterns are refused before anything is
 * fetched; a status delivery with no reference is shown honestly; a reply that cannot be tied to its digest applies no
 * correction; and an empty list from an incomplete read is never presented as clear.
 * Dates are fixed: 2026-10-01 is a Thursday.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');
var { main, inScope } = require('../slack-run.js');
var { settings } = require('../src/config.js');
var S = require('../src/status.js');
var L = require('../src/ledger.js');

var ROOT = path.join(__dirname, '..'), NL = String.fromCharCode(10), ME = 'alex@example.com';
var tmp = function () { return fs.mkdtempSync(path.join(os.tmpdir(), 'ol-batch-')); };
var run = function (script, args, cwd) { return cp.spawnSync(process.execPath, [path.join(ROOT, script)].concat(args), { encoding: 'utf8', cwd: cwd }); };
var at = function (mo, day, h) { return (Date.UTC(2026, mo - 1, day, h) / 1000).toFixed(6); };
var banner = function (ts, body, lena) {
  return '=== Message from ' + (lena ? 'Lena Borg' : 'Alex Rivera') + ' <' + (lena ? 'lena@vf.example' : ME) + '> (' + (lena ? 'U0EXAMPLE002' : 'U0EXAMPLE001') +
    ') at ' + ts + ' UTC ===' + NL + 'Message TS: ' + ts + NL + body;
};

/* ------------------------------ 1. the sanitizer never silently overwrites ------------------------------ */
var sd = tmp();
fs.mkdirSync(path.join(sd, 'x')); fs.mkdirSync(path.join(sd, 'y'));
var cap = function (n, who, email, id, text) { return '=== Message from ' + who + ' <' + email + '> (' + id + ') at 1790000000.000100 UTC ===' + NL + 'Message TS: 1790000000.000100' + NL + text; };
fs.writeFileSync(path.join(sd, 'x', 'c.txt'), cap(1, 'Alex R', 'me@corp.example', 'U04ME000001', 'first file'));
fs.writeFileSync(path.join(sd, 'y', 'c.txt'), cap(2, 'Jane Doe', 'jane@acme.example', 'U04JANE0002', 'second file'));
var san = function (files, extra) {
  return run('tools/sanitize-capture.js', ['--you', 'me@corp.example', '--self', 'U04ME000001', '--out', path.join(sd, 'out')].concat(extra || [], files));
};
var two = san([path.join(sd, 'x', 'c.txt'), path.join(sd, 'y', 'c.txt')]);
assert.strictEqual(two.status, 2, 'two inputs with one name stop the run');
assert.ok(two.stderr.indexOf('sanitize-capture: two inputs would write the same output file "c.txt" (') === 0 && /Nothing was written\. Rename one, or run them separately\./.test(two.stderr), two.stderr);
assert.ok(!fs.existsSync(path.join(sd, 'out')), 'and nothing was written, not even the directory');
var twoForced = san([path.join(sd, 'x', 'c.txt'), path.join(sd, 'y', 'c.txt')], ['--overwrite']);
assert.strictEqual(twoForced.status, 2, '--overwrite never permits two inputs to collide within one run');
assert.ok(!fs.existsSync(path.join(sd, 'out')));
var one = san([path.join(sd, 'x', 'c.txt')]);
assert.strictEqual(one.status, 0, one.stderr);
var written = fs.readFileSync(path.join(sd, 'out', 'c.txt'), 'utf8');
var again = san([path.join(sd, 'y', 'c.txt')]);
assert.strictEqual(again.status, 2, 'an output that already exists is not replaced silently');
assert.ok(/sanitize-capture: .*c\.txt already exists\. Nothing was written\. Remove it, or pass --overwrite\./.test(again.stderr), again.stderr);
assert.strictEqual(fs.readFileSync(path.join(sd, 'out', 'c.txt'), 'utf8'), written, 'the earlier output is untouched');
var replaced = san([path.join(sd, 'y', 'c.txt')], ['--overwrite']);
assert.strictEqual(replaced.status, 0, replaced.stderr);
assert.ok(/second file/.test(fs.readFileSync(path.join(sd, 'out', 'c.txt'), 'utf8')), 'replacing is possible when it is said outright');
// What success claims, and does not.
assert.ok(/wrote 1 file\(s\) to .* This checks only the identifiers it found\. It does not establish the output is safe to publish: read every file before committing it\./.test(one.stdout), one.stdout);
assert.ok(!/anonymous/i.test(one.stdout.replace(/does not establish[^\n]*/, '')), 'the output never calls the result anonymous or safe');
var sanSrc = fs.readFileSync(path.join(ROOT, 'tools', 'sanitize-capture.js'), 'utf8');
assert.ok(/does NOT mean a capture is anonymous or safe to publish/.test(sanSrc), 'the tool says what its guarantee stops at');
var agents = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8').split(String.fromCharCode(13)).join('');
assert.ok(/does not make a capture anonymous or safe to publish/.test(agents), 'and so does AGENTS.md');
// The limits are real: these pass through with exit 0. They are documented, not fixed, so nobody mistakes a clean run for safety.
fs.writeFileSync(path.join(sd, 'leaky.txt'), '=== Message from Mary Quinn at 1790000003.000100 UTC ===' + NL + 'Message TS: 1790000003.000100' + NL + "reach bob.o'brien@acme.example or josé@acme.example");
var leaky = run('tools/sanitize-capture.js', ['--you', 'me@corp.example', '--self', 'U04ME000001', '--out', path.join(sd, 'leak-out'), path.join(sd, 'leaky.txt')]);
var leakedOut = fs.readFileSync(path.join(sd, 'leak-out', 'leaky.txt'), 'utf8');
assert.strictEqual(leaky.status, 0);
assert.ok(/Mary Quinn/.test(leakedOut) && /josé@/.test(leakedOut) && /bob\.o'/.test(leakedOut), 'a clean exit is not evidence: unmapped names and unusual emails survive');
assert.ok(/does not establish the output is safe to publish/.test(leaky.stdout), 'and the run says so');

/* ------------------------------ 2. malformed channel patterns are refused before fetching ------------------------------ */
var cfgDir = tmp(), cfgPath = path.join(cfgDir, 'openloops.config.json');
var writeCfg = function (channels) { fs.writeFileSync(cfgPath, JSON.stringify({ you: ME, selfDm: 'U0EXAMPLE001', channels: channels })); };
var BAD = [
  [{ exclude: ['*-private'] }, '"channels.exclude" entry "*-private" is not supported — a * is only allowed at the end ("team-*")'],
  [{ exclude: ['h*r'] }, '"channels.exclude" entry "h*r" is not supported — a * is only allowed at the end ("team-*")'],
  [{ exclude: ['*'] }, '"channels.exclude" entry "*" is not supported — a * is only allowed at the end ("team-*")'],
  [{ exclude: [' #deals'] }, '"channels.exclude" entry " #deals" has leading or trailing spaces'],
  [{ exclude: ['#deals '] }, '"channels.exclude" entry "#deals " has leading or trailing spaces'],
  [{ exclude: [''] }, '"channels.exclude" entry "" is empty'],
  [{ exclude: ['#'] }, '"channels.exclude" entry "#" is empty'],
  [{ include: ['a*b'] }, '"channels.include" entry "a*b" is not supported — a * is only allowed at the end ("team-*")'],
  [{ include: ['ops', ' finance'] }, '"channels.include" entry " finance" has leading or trailing spaces']
];
BAD.forEach(function (c) {
  writeCfg(c[0]);
  assert.throws(function () { settings(fs, cfgPath, {}); }, function (e) { return e.message.indexOf(c[1]) > -1; }, 'settings refuses ' + c[1]);
  var r = run('slack-run.js', ['--check-config', '--config', cfgPath]);
  assert.strictEqual(r.status, 3, c[1] + ' (3: the configuration cannot be used)');
  assert.strictEqual(r.stderr.trim(), 'open-loops: Config is unusable: ' + c[1] + '. Fix the configuration before fetching or running a digest.');
  assert.ok(!/Nothing was fetched/.test(r.stderr), 'the checker does not claim to know what was fetched');
});
// Fine ones are fine, including a DM name with spaces and a trailing wildcard.
[{ include: ['#ops', 'finance', 'team-*', '#eng-*', 'DM with Lena H'], exclude: ['#social', 'random*'] }, {}, { include: [] }].forEach(function (ch) {
  writeCfg(ch);
  assert.doesNotThrow(function () { settings(fs, cfgPath, {}); });
  var ok = run('slack-run.js', ['--check-config', '--config', cfgPath]);
  assert.ok(ok.status === 0 && ok.stdout.trim() === 'Config OK.', JSON.stringify(ch) + ' ' + ok.stderr);
});
assert.strictEqual(inScope('#team-a', { include: ['team-*'] }), true);
assert.strictEqual(inScope('#hr-private', { exclude: ['hr-*'] }), false, 'a trailing wildcard still excludes');
// A run input's own scope is held to the same rule, and a config that cannot be read at all is also "unusable".
writeCfg({ include: ['#ops'] });
var noFile = run('slack-run.js', ['--check-config', '--config', path.join(cfgDir, 'missing.json')]);
assert.strictEqual(noFile.status, 3, 'a config that cannot be found is unusable: 3');
var skillText = fs.readFileSync(path.join(ROOT, 'skills', 'open-loops', 'SKILL.md'), 'utf8').split(String.fromCharCode(13)).join('');
var running = skillText.slice(skillText.indexOf('## Running the digest'));
assert.ok(running.indexOf('--check-config') > -1 && running.indexOf('--check-config') < running.indexOf('**Fetch.** Each in-scope channel'), 'SKILL.md checks the configuration before fetching');
assert.ok(skillText.slice(0, skillText.indexOf('## Running the digest')).indexOf('--check-config') > -1, 'and right after setup writes it');

/* ------------------------------ 3. a delivery with no reference, and "the same one" ------------------------------ */
var sdir = tmp();
var now = S.parseNow('2026-10-01T12:00');
var DELIVERED_AT = '2026-09-21T22:01:00.000Z';
var writeStatus = function (d, o) { fs.writeFileSync(path.join(d, 'status.json'), JSON.stringify(o)); };
var attempt = function (endedAt, ref) { return { id: '0123abcd', date: '2026-09-21', startedAt: '2026-09-21T22:00:00.000Z', endedAt: endedAt, outcome: 'delivered', ref: ref, notice: 'none' }; };
writeStatus(sdir, { delivered: { date: '2026-09-21', at: DELIVERED_AT }, attempt: attempt(DELIVERED_AT, null) });
var v1 = S.view(sdir, {}, null, now, {});
assert.ok(/Last delivered digest {3}.*· ref not recorded\n/.test(v1) && !/ref null/.test(v1), v1);
assert.ok(/Last attempt {12}the same one/.test(v1), 'the same attempt is recognised by its completion time, even with no reference: ' + v1);
// Two different attempts on one date, neither with a reference, are not "the same one".
var sdir2 = tmp();
writeStatus(sdir2, { delivered: { date: '2026-09-21', at: DELIVERED_AT }, attempt: attempt('2026-09-21T23:30:00.000Z', null) });
var v2 = S.view(sdir2, {}, null, now, {});
assert.ok(!/the same one/.test(v2), 'a later attempt with the same date and a missing ref is not the recorded delivery: ' + v2);
assert.ok(/Last attempt {12}Mon 09-21, \d\d:\d\d — delivered/.test(v2), v2);
// A reference that is there is still shown, and an invalid one is damage, preserved rather than trusted.
var sdir3 = tmp();
writeStatus(sdir3, { delivered: { date: '2026-09-21', at: DELIVERED_AT, ref: '7c1e' } });
assert.ok(/· ref 7c1e\n/.test(S.view(sdir3, {}, null, now, {})));
var sdir4 = tmp();
writeStatus(sdir4, { delivered: { date: '2026-09-21', at: DELIVERED_AT, ref: 'ref null' } });
assert.ok(S.load(sdir4).damaged && S.load(sdir4).delivered === null, 'an invalid reference is not trusted');
S.repair(sdir4, now);
assert.strictEqual(fs.readdirSync(sdir4).filter(function (f) { return /^status\.json\.damaged-/.test(f); }).length, 1, 'and the original is preserved');

/* ------------------------------ 4. a reply that cannot be tied to its digest rejects nothing ------------------------------ */
var d4 = tmp(), c4 = path.join(d4, 'c.json');
fs.writeFileSync(c4, JSON.stringify({ you: ME, selfDm: 'U0EXAMPLE001', tzOffset: 0, spotCheck: 0, ledger: path.join(d4, 'l.json'), channels: { include: ['#ops'] } }));
var chat1 = [banner(at(9, 25, 10), 'Please send the pricing Tuesday Sep 29.', 1), banner(at(9, 28, 10), "We'll send the contract Thursday Oct 1.", 1)].join(NL);
var chat2 = chat1 + NL + banner(at(10, 1, 8), 'Urgent: please send the invoice today Oct 1.', 1);
var mk = function (today, chat, extra) {
  var p = path.join(d4, 'i-' + today + '-' + Object.keys(extra || {}).join('_') + '.json');
  fs.writeFileSync(p, JSON.stringify(Object.assign({ today: today, conversations: [{ channel: '#ops', members: [], text: chat, complete: true }], dm: { channel: 'D0', text: '' } }, extra || {})));
  return p;
};
var itemsOf = function (t) { return t.split(NL).filter(function (l) { return /^ ?\d+ {2}/.test(l); }).map(function (l) { return l.replace(/\s+/g, ' ').trim(); }); };
var dg1 = main([mk('2026-09-30', chat1), '--config', c4]);
var dg2 = main([mk('2026-10-01', chat2), '--config', c4]);
// The two numbered lists differ at item 2: the contract yesterday, the invoice today.
assert.ok(/^2 \S+ Chase Lena — "We'll send the contract/.test(itemsOf(dg1)[1]) && /^2 today Answer Lena — "Urgent: please send the invoice/.test(itemsOf(dg2)[1]), itemsOf(dg1).concat(itemsOf(dg2)).join(' | '));
var ts1 = at(9, 30, 22), ts2 = at(10, 1, 22);
var digestIn = function (ts, d) { return banner(ts, '```' + NL + d + NL + '```'); };
var dmText = digestIn(ts1, dg1) + NL + digestIn(ts2, dg2);
var reply2 = banner(at(10, 2, 9), '2');
var verdictsOf = function () { return JSON.parse(fs.readFileSync(path.join(d4, 'l.json'), 'utf8')).rows.filter(function (r) { return r[L.COL.verdict]; }).map(function (r) { return r[L.COL.what]; }); };
var snapshot = fs.readFileSync(path.join(d4, 'l.json'), 'utf8');

// No root: the "2" under yesterday's digest used to reject TODAY's item 2, the invoice.
var noRoot = main([mk('2026-10-02', chat2, { dm: { channel: 'D0', text: dmText }, dmThread: [{ text: digestIn(ts1, dg1) + NL + reply2 }] }), '--config', c4]);
assert.ok(!/Took your last reply/.test(noRoot), 'nothing was applied');
assert.deepStrictEqual(verdictsOf(), [], 'and no item was rejected');
assert.ok(noRoot.indexOf('NOT APPLIED — a reply could not be matched to a digest (its thread has no reference, or the digest it answers was not read). Reply again under the digest you meant.') > -1, 'the warning is shown');
assert.ok(/\n1 read warning — in the thread\./.test(noRoot), 'and counted in the brief');
// A root whose digest was not read: the same.
fs.writeFileSync(path.join(d4, 'l.json'), snapshot);
var orphan = main([mk('2026-10-03', chat2, { dm: { channel: 'D0', text: '' }, dmThread: [{ root: ts1, text: reply2 }] }), '--config', c4]);
assert.ok(!/Took your last reply/.test(orphan) && verdictsOf().length === 0, 'a reply under a digest that was not read rejects nothing');
assert.ok(/NOT APPLIED — a reply could not be matched to a digest/.test(orphan), 'and says so');
// The control: with its root, the same reply is applied to the right list — yesterday's item 2, the contract.
fs.writeFileSync(path.join(d4, 'l.json'), snapshot);
var rooted = main([mk('2026-10-04', chat2, { dm: { channel: 'D0', text: dmText }, dmThread: [{ root: ts1, text: digestIn(ts1, dg1) + NL + reply2 }] }), '--config', c4]);
assert.ok(/Took your last reply — 1 marked not real/.test(rooted), rooted.split(NL).slice(0, 6).join(' / '));
assert.deepStrictEqual(verdictsOf(), ["We'll send the contract Thursday Oct 1."], 'applied to the digest it answered');
assert.ok(!/could not be matched to a digest/.test(rooted), 'and no warning when everything matched');

/* ------------------------------ 5. an empty list from an incomplete read is not "clear" ------------------------------ */
var d5 = tmp(), c5 = path.join(d5, 'c.json');
fs.writeFileSync(c5, JSON.stringify({ you: ME, selfDm: 'U0EXAMPLE001', tzOffset: 0, spotCheck: 0, ledger: path.join(d5, 'l.json'), channels: { include: ['#ops'] } }));
var quiet = banner(at(9, 30, 10), 'Thanks all, see you.', 1);
var readWith = function (conv) {
  var p = path.join(d5, 'i' + Math.random().toString(16).slice(2) + '.json');
  fs.writeFileSync(p, JSON.stringify({ today: '2026-10-01', conversations: [conv], dm: { channel: 'D0', text: '' } }));
  return main([p, '--config', c5, '--dry']).split('-- thread --')[0];
};
var incomplete = readWith({ channel: '#ops', members: [], oldest: '1', pages: [{ text: quiet, pagination_info: 'There are more messages. next_cursor: "abc"' }] });
assert.ok(/\n0 open · read incomplete\n/.test(incomplete), incomplete);
assert.ok(incomplete.indexOf('Nothing found in what was read — but the read was INCOMPLETE. Do not treat this as clear.') > -1, incomplete);
assert.ok(!/Nothing outstanding/.test(incomplete), 'it never says the list is empty, genuinely');
assert.ok(/1 read warning — in the thread\./.test(incomplete), 'and the warning count is still there');
var complete = readWith({ channel: '#ops', members: [], text: quiet, complete: true });
assert.ok(/\n0 open\n/.test(complete) && /Nothing outstanding\. Genuinely — the list is empty\./.test(complete) && !/INCOMPLETE|read incomplete/.test(complete), 'a complete read keeps the approved sentence: ' + complete);
var blind = readWith({ channel: '#ops', members: [], text: 'nothing here looks like a message at all' });
assert.ok(/READ NOTHING/.test(blind) && !/Nothing found in what was read/.test(blind), 'a read that parsed nothing keeps its own, stronger line');
// With items listed, the counts line is unchanged: the new line is only for an empty list.
var withItem = readWith({ channel: '#ops', members: [], oldest: '1', pages: [{ text: banner(at(9, 28, 10), 'Please send the pricing Tuesday Sep 29.', 1), pagination_info: 'There are more messages. next_cursor: "abc"' }] });
assert.ok(/\n1 overdue · 1 open\n/.test(withItem) && !/read incomplete/.test(withItem), withItem);

console.log('safety batch: OK');
