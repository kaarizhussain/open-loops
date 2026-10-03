/* The status view is what people open when something is wrong, and a damaged config used to stop it before it showed the
 * delivery history, which is stored separately and was fine (codex-debug-review, 2026-10-02, finding 6). It now shows the
 * history and names the config problem in place of the parts that need the config.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var { main } = require('../tools/status.js');

var d = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-badcfg-')), cfg = path.join(d, 'openloops.config.json');
var at = '2026-10-01T22:05:00.000Z', started = '2026-10-01T22:02:00.000Z';
var delivered = { date: '2026-10-01', at: at, startedAt: started, ref: '1ded', read: { state: 'complete', why: [] },
  channels: ['#ops'], conversations: 1, messages: 3, meetings: 0, windowDays: 21 };
var status = JSON.stringify({ attempt: { id: 'b0b60850', date: '2026-10-01', startedAt: started, outcome: 'delivered', cause: null, endedAt: at,
  brief: 'posted', details: 'posted', verified: true, ref: '1ded', notice: 'none' }, delivered: delivered }, null, 1);
fs.writeFileSync(path.join(d, 'status.json'), status);
var show = function () { return main(['--show', '--read-only', '--config', cfg], function () {}); };

// A config that is not JSON.
fs.writeFileSync(cfg, '{"you": "alex@example.com",\n');
var out = show();
assert.ok(/Last delivered digest\s+.*ref 1ded/.test(out), 'the delivery history is shown: ' + out);
assert.ok(/Tracking\s+the configuration cannot be read: Config at .* could not be read \(.*\)\. Fix it rather than deleting it\./.test(out), 'the config problem is named');
assert.ok(out.indexOf('Midday alerts unknown · Diagnostic reports unknown') > -1, 'and what depends on it is unknown, not off');
assert.strictEqual(fs.readFileSync(path.join(d, 'status.json'), 'utf8'), status, 'read-only changes nothing');

// A config that parses but is not an object is the same kind of problem.
fs.writeFileSync(cfg, '[]');
out = show();
assert.ok(/ref 1ded/.test(out) && /the configuration cannot be read: the config file must hold a JSON object, got \[\]\. Fix it/.test(out), 'a non-object config too: ' + out);

// A good config is shown as before.
fs.writeFileSync(cfg, JSON.stringify({ you: 'alex@example.com', tzOffset: 0 }));
out = show();
assert.ok(out.indexOf('cannot be read') === -1 && /Midday alerts off · Diagnostic reports off/.test(out), 'a readable config is unchanged');

fs.rmSync(d, { recursive: true, force: true });
console.log('status with a damaged config: OK');
