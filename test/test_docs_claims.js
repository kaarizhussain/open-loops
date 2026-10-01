/* Claims in the docs that the code can contradict, checked against the code. Each was wrong once:
 *   - SLACK.md quoted an acknowledgement the digest does not print
 *   - SLACK.md said nothing is proposed until "a couple of dozen" items are judged; two rejections are enough
 *   - SLACK.md's loop skipped response_format, the paged DM lookup and dmLookup, and named the wrong id for the config
 *   - SKILL.md sent you to "step 1" for the profile that step 2 reads, and gave a 40% rate the benchmark does not show
 *   - the remote-run notes said the rendered digest is saved by a step that does not exist
 *   - the README named the config key `principals`, which a config file ignores
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var L = require('../src/ledger.js');
var { settings } = require('../src/config.js');

var ROOT = path.join(__dirname, '..');
var read = function (p) { return fs.readFileSync(path.join(ROOT, p), 'utf8').split(String.fromCharCode(13)).join(''); };
var slack = read('SLACK.md'), skill = read('skills/open-loops/SKILL.md'), readme = read('README.md'), remote = read('docs/remote-run.md'), digestSrc = read('src/digest.js');
var flat = function (s) { return s.replace(/\s+/g, ' '); };

// The acknowledgement: what the digest builds is what SLACK.md quotes.
assert.ok(digestSrc.indexOf("' marked not real' + span(") > -1 && digestSrc.indexOf("', dropped for good'") > -1, 'the digest still builds this wording (a reply that used a range adds its range after \"not real\")');
assert.ok(flat(slack).indexOf('Took your last reply — 2 marked not real, dropped for good.') > -1, 'SLACK.md quotes it');
assert.ok(!/2 items marked wrong/.test(flat(slack)));

// Mutes: two rejections propose, four act. No judged-count gate exists, so none is promised.
var SENT = ['We will look at that at some point', 'Maybe at some point soon', 'Revisit this at some point', 'Not now, at some point'];
var rows = function (n) { var r = []; for (var i = 0; i < n; i++) r.push(['k' + i, '2026-09-01', '', '', 'owed_by_us', 'a', SENT[i], 'x']); return r; };
var phrases = function (list) { return list.map(function (s) { return s.phrase; }); };
assert.ok(phrases(L.suggestMutes(rows(2))).indexOf('at some point') > -1, 'two rejected items propose a phrase');
assert.strictEqual(L.suggestMutes(rows(3), 4).length, 0, 'three do not act on their own');
assert.ok(phrases(L.suggestMutes(rows(4), 4)).indexOf('at some point') > -1, 'four do');

assert.ok(!/couple of\s+dozen/.test(slack) && /two rejected items is offered in the digest/.test(flat(slack)), 'SLACK.md says what the code does');
assert.ok(/At four rejections/.test(slack) && !/Past four rejections/.test(slack));
assert.ok(!/couple of dozen/.test(read('src/ledger.js')), 'and so does the comment beside the code');

// The loop outline: every read names its format, the DM lookup pages, and the input carries dmLookup.
var loop = slack.slice(slack.indexOf('## The loop'), slack.indexOf('**2. Write what came back.**'));
(loop.match(/slack_read_(?:channel|thread)\([^)]*\)/g) || []).forEach(function (call) { assert.ok(/response_format="detailed"/.test(call), call + ' names its format'); });
assert.ok(/dm-lookup\.js/.test(loop) && /skills\/open-loops\/SKILL\.md/.test(slack.slice(slack.indexOf('## The loop'), slack.indexOf('## The loop') + 600)), 'the outline defers to SKILL.md and mentions the paged lookup');
assert.ok(/"dmLookup":/.test(slack), 'the input example has dmLookup');
assert.ok(/Slack user id/.test(slack) && !/DM channel straight off/.test(slack), 'the config takes the user id, not a channel');

// SKILL.md: step numbers, and the benchmark.
var step2 = skill.slice(skill.indexOf('**2. Find out who they are.**'), skill.indexOf('**3.'));
assert.ok(/slack_read_user_profile/.test(step2), 'the profile is read in step 2');
assert.ok(/"you": "<from step 2>"/.test(skill) && !/<from step 1>/.test(skill));
assert.ok(!/two of every five/.test(skill), 'no 40% claim');
assert.ok(/firing rate, from the Enron benchmark/.test(skill) && /about 36 items per 100 messages/.test(skill) && /not how often it is right/.test(skill) && /not a prediction for theirs/.test(skill),
  'the figure is attributed, and is not presented as accuracy or as a forecast');
assert.ok(/35\.8 items per 100/.test(read('docs/evaluation.md')), 'and matches the benchmark write-up');
assert.ok(!/from the saved\s+runner output/.test(skill), 'nothing is reposted from a file that nobody saves');

// The remote-run notes do not claim a save that no step performs.
assert.ok(!/Each run's rendered digest is saved/.test(remote) && /Saving each run's rendered digest is not done yet/.test(remote));
assert.ok(!/out-\d|out-YYYY/.test(skill) && !/tee |> out/.test(skill), 'and no instruction saves it');

// The config key: `supporting` is what a config file reads, and `principals` there is ignored.
var d = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ol-docs-')), c = path.join(d, 'c.json');
fs.writeFileSync(c, JSON.stringify({ you: 'a@b.co', supporting: [{ label: 'Dana' }], principals: [{ label: 'Marcus' }] }));
assert.deepStrictEqual(settings(fs, c, {}).supporting, [{ label: 'Dana' }], 'supporting is the config key, and principals in a config file does nothing');
assert.ok(/In `openloops\.config\.json` it is `"supporting"`/.test(readme) && /a `principals` key there does nothing/.test(readme), 'the README says so');

// The ledger's identity token is disclosed where storeText is explained.
assert.ok(/With `storeText: false` the ledger also keeps a salted one-way identifier of who said each item, only so that two people's identical sentences stay apart\./.test(skill), 'SKILL.md discloses the identifier');

console.log('docs claims: OK');
