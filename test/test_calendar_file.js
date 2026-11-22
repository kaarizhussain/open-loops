/* A calendar too large to hand over inline, and a calendar that was not handed over at all (found on the first no-human rehearsal, 2026-11-22).
 *
 * The calendar grew from 1 event to 89 in six weeks, and its list_events response (104,643 characters) crossed the connector's size limit: the response is no
 * longer returned to the model, it is saved to a file and the model is told where. Retyping that into the input is the copying the immutability rule forbids,
 * so the run left the calendar out — and a digest built without it said "0 meetings", the same words as an empty diary.
 *
 *   eventsFile   the input may name the saved file; the runner reads it itself, only from a tool-results folder or beside the config
 *   useCalendar  written as true in the config, it means a calendar exists: a run that brings none says so (CALENDAR NOT READ)
 *
 * Left out of the config, nothing changes, which is what every existing setup and fixture relies on.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var { main } = require('../slack-run.js');

var ME = 'alex@example.com';
var d = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-calfile-'));
var other = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-calfile-else-'));
fs.mkdirSync(path.join(d, 'saved', 'tool-results'), { recursive: true });
var n = 0;

var CAL = { events: [{ id: 'e1', summary: 'Client sync', status: 'confirmed', start: { dateTime: '2026-10-07T09:00:00-04:00' }, attendees: [{ email: 'lena@client.com' }] }] };
var real = { channel: '#ops', members: [], complete: true, messages: [{ ts: '1790870400.000001', user: 'U0EXAMPLE001', text: "I'll send the signed contract Friday." }] };

var digest = function (config, inputExtra) {
  var cfg = path.join(d, 'cfg' + n + '.json'), input = path.join(d, 'in' + n + '.json');
  fs.writeFileSync(cfg, JSON.stringify(Object.assign({ you: ME, selfUid: 'U0EXAMPLE001', tzOffset: 0, lookbackDays: 21, spotCheck: 0, ledger: 'ledger' + n + '.json' }, config)));
  fs.writeFileSync(input, JSON.stringify(Object.assign({ today: '2026-10-05', conversations: [real], dm: { messages: [] }, dmLookup: 'searched_none' }, inputExtra)));
  n++;
  var before = fs.readFileSync(input, 'utf8');
  var out = main([input, '--config', cfg, '--dry']);
  assert.strictEqual(fs.readFileSync(input, 'utf8'), before, 'the input is never edited');
  return out;
};
var noRef = function (s) { return String(s).replace(/ · ref [0-9a-f]{4}/g, ''); };
var save = function (dir, name, text) { var f = path.join(dir, name); fs.writeFileSync(f, text); return f; };
var meetings = function (out) { var m = /and (\d+) meetings/.exec(out); return m ? Number(m[1]) : null; };

/* ------------------------------ eventsFile ------------------------------ */
var inline = digest({}, { events: CAL });
assert.strictEqual(meetings(inline), 1, 'inline: the meeting is read');
assert.ok(!/CALENDAR NOT READ/.test(inline));

var saved = save(path.join(d, 'saved', 'tool-results'), 'list_events.txt', JSON.stringify(CAL));
var fromFile = digest({}, { eventsFile: saved });
assert.strictEqual(meetings(fromFile), 1, 'a connector result saved in a tool-results folder is read');
assert.ok(!/CALENDAR NOT READ/.test(fromFile));
assert.strictEqual(noRef(fromFile), noRef(inline), 'and gives the digest the same response given inline would');

var beside = digest({}, { eventsFile: save(d, 'calendar.json', JSON.stringify(CAL)) });
assert.strictEqual(meetings(beside), 1, 'a file beside the config is read too');

// A byte-order mark does not make the response unreadable.
assert.strictEqual(meetings(digest({}, { eventsFile: save(path.join(d, 'saved', 'tool-results'), 'bom.txt', '﻿' + JSON.stringify(CAL)) })), 1);

var refused = function (label, extra, why) {
  var out = digest({}, extra);
  assert.ok(/CALENDAR NOT READ/.test(out), label + ': says so\n' + out);
  assert.ok(why.test(out), label + ': says why (' + why + ')\n' + out);
  assert.strictEqual(meetings(out), 0, label + ': nothing was read');
  assert.ok(/unprepped meetings and unbooked calls were not checked/.test(out), label + ': says what was not checked');
};
refused('outside both places', { eventsFile: save(other, 'cal.json', JSON.stringify(CAL)) }, /not in a tool-results folder or beside the config/);
refused('a relative path', { eventsFile: 'saved/tool-results/list_events.txt' }, /not an absolute path/);
refused('a missing file', { eventsFile: path.join(d, 'saved', 'tool-results', 'nope.txt') }, /does not exist/);
refused('a directory', { eventsFile: path.join(d, 'saved', 'tool-results') }, /not a file/);
refused('a path that is not a string', { eventsFile: 7 }, /not an absolute path/);
refused('both inline and by file', { eventsFile: saved, events: CAL }, /both events and eventsFile/);
refused('too large', { eventsFile: save(path.join(d, 'saved', 'tool-results'), 'big.txt', Buffer.alloc(5 * 1024 * 1024 + 1, 32)) }, /larger than 5 MB/);
// Not a calendar response: the same words as an inline one that cannot be parsed.
var junk = digest({}, { eventsFile: save(path.join(d, 'saved', 'tool-results'), 'junk.txt', 'Error: result exceeds maximum allowed tokens') });
assert.ok(/CALENDAR NOT READ — the calendar response could not be parsed/.test(junk), junk);

/* ------------------------------ useCalendar ------------------------------ */
var missing = digest({ useCalendar: true }, {});
assert.ok(/CALENDAR NOT READ — this run's input held no calendar, so unprepped meetings and unbooked calls were not checked this run\./.test(missing), missing);
assert.strictEqual(meetings(missing), 0);

['absent from the config', 'false'].forEach(function (label, i) {
  var out = digest(i === 0 ? {} : { useCalendar: false }, {});
  assert.ok(!/CALENDAR NOT READ/.test(out), 'useCalendar ' + label + ': no calendar is not reported\n' + out);
});
assert.ok(!/CALENDAR NOT READ/.test(digest({ useCalendar: true }, { events: CAL })), 'a calendar that came: nothing to say');
assert.ok(!/CALENDAR NOT READ/.test(digest({ useCalendar: true }, { eventsFile: saved })), 'and one that came by file');
assert.ok(!/CALENDAR NOT READ/.test(digest({ useCalendar: true }, { events: { events: [] } })), 'an empty diary is a diary');
assert.throws(function () { digest({ useCalendar: 'yes' }, {}); }, /"useCalendar" must be true or false/, 'a value that is not true or false stops the run, as every other bad setting does');

console.log('calendar file: OK');
