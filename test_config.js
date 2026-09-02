/* Settings, and the fact that they are not the same thing as a run.
 *
 * Before this existed, every setting had to be re-supplied by whoever assembled the
 * input. That works when the assembler is a person writing JSON by hand and does not
 * work at all for anybody else — there was nowhere to put a setup. */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var { DEFAULTS, merge, loadConfig, settings } = require('./src/config.js');

var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openloops-cfg-'));
var write = function (name, obj) {
  var p = path.join(dir, name);
  fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return p;
};

/* --- one line is a valid config --- */
var minimal = settings(fs, write('a.json', { you: 'ea@company.com' }), {});
assert.strictEqual(minimal.you, 'ea@company.com');
assert.strictEqual(minimal.lookbackDays, 21, 'everything else takes a working default');
assert.deepStrictEqual(minimal.supporting, [], 'supporting nobody is the common case');
assert.strictEqual(minimal.ledger, 'ledger.json');

/* The one thing with no sensible default. Every signal depends on telling inbound from
   outbound, and that needs an address. */
assert.throws(function () { settings(fs, write('b.json', {}), {}); },
  /Config is incomplete[\s\S]*"you"/);
assert.strictEqual(settings(fs, write('c.json', { you: 'EA@Company.com' }), {}).you,
  'ea@company.com', 'addresses are compared lowercased, so it is stored that way');

/* --- later wins, so a one-off does not mean editing the file --- */
var over = settings(fs, write('d.json', { you: 'a@b.com', lookbackDays: 21 }),
                    { lookbackDays: 60 });
assert.strictEqual(over.lookbackDays, 60, 'the run overrides the file');
assert.strictEqual(
  settings(fs, write('e.json', { you: 'a@b.com', lookbackDays: 7 }), { lookbackDays: undefined })
    .lookbackDays, 7, 'but an absent value is not an override');

/* Nested one level, which is all `channels` needs — a format that recurses is one
   nobody can predict the merge behaviour of. */
var chans = settings(fs, write('f.json', { you: 'a@b.com', channels: { exclude: ['#hr'] } }),
                     { channels: { include: ['#deals'] } });
assert.deepStrictEqual(chans.channels.exclude, ['#hr'], 'the file keeps what the run did not set');
assert.deepStrictEqual(chans.channels.include, ['#deals']);

/* --- a missing file is fine; a broken one is not --- */
assert.deepStrictEqual(loadConfig(fs, path.join(dir, 'nope.json')), {},
  'no config file is a working state for anyone who passes their address on the run');
assert.throws(function () { settings(fs, write('g.json', '{ not json'), { you: 'a@b.com' }); },
  /could not be read/,
  'but falling back to defaults would quietly read channels somebody had excluded');

/* --- the shipped example has to actually work --- */
var example = JSON.parse(fs.readFileSync(path.join(__dirname, 'openloops.config.example.json'), 'utf8'));
delete example._comment;
Object.keys(example).forEach(function (k) {
  assert.ok(k in DEFAULTS, 'the example documents a setting that exists: ' + k);
});
Object.keys(DEFAULTS).forEach(function (k) {
  assert.ok(k in example, 'and every setting is in the example: ' + k);
});

fs.rmSync(dir, { recursive: true, force: true });
console.log('config: OK');
