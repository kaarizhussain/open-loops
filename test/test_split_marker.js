/* The runner fits each posted part to Slack's 4000-character limit by measuring the longest part of the rendered digest. The parts are
 * separated by a line holding only "-- thread --". It used to split on the substring, so a commitment quoting "-- thread --" mid-sentence
 * cut a long part into short fragments and the longest measured far shorter than the real part: an oversize part passed the fit check
 * and would have been posted (adversarial review 2026-10-05, tooling E1).
 */
var assert = require('assert');
var { longestPart } = require('../slack-run.js');
var digest = require('../src/digest.js');

var NL = String.fromCharCode(10), M = digest.SPLIT;
var item = function (i) { return ' ' + i + '  2d late   You: "I will send the report ' + M + ' with every regional figure to finance."'; };
var brief = 'OPEN LOOPS — for 2026-10-05' + NL + '3 open';
var details = []; for (var i = 1; i <= 60; i++) details.push(item(i));
var detailText = details.join(NL);
var text = brief + NL + NL + M + NL + NL + detailText;

assert.ok(detailText.length > 4000, 'the details part is over the limit (' + detailText.length + ')');
assert.ok(detailText.split(M).length > 50, 'and quotes the marker many times mid-line');
assert.strictEqual(longestPart(text), detailText.trim().length, 'its length is measured whole, not as the longest fragment between the quoted markers');
assert.ok(longestPart(text) + 8 > 4000, 'so the fit check sees that it is too long');

// Ordinary digests are measured as ever: the brief and the details separately, the longer one wins.
assert.strictEqual(longestPart(brief + NL + NL + M + NL + NL + 'short'), brief.length, 'the brief is longer here');
assert.strictEqual(longestPart('only one part'), 'only one part'.length, 'no marker, one part');
assert.strictEqual(longestPart(brief + NL + NL + M + NL + NL + M + NL), brief.length, 'adjacent marker lines leave empty parts');

console.log('split marker: OK');
