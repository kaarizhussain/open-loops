/* Settings, kept apart from the run.
 *
 * These two things had been travelling together in one JSON file, and they are not the
 * same kind of thing at all. Who you are, who you support and which channels may be
 * read are stable — written once, edited rarely, worth keeping in version control or a
 * dotfile. The conversations fetched this morning are none of those things.
 *
 * Mixing them meant there was nowhere for a person to *put* their setup: every setting
 * had to be re-supplied by whoever assembled the input, which works when the assembler
 * is a human writing JSON by hand and does not work at all for anybody else.
 *
 * Everything here has a default that does something sensible, so a config file with a
 * single line in it is a valid config file. The only setting with no useful default is
 * `you` — without an address there is no way to tell an inbound message from an
 * outbound one, and every signal in the detector depends on that distinction.
 */

var DEFAULTS = {
  you: null,                  // required: the address messages are outbound from
  supporting: [],             // who you support. [] means nobody — you read your own work

  // Slack
  selfDm: null,               // the channel the digest is posted to and read back from
  channels: { include: [], exclude: [] },   // include is an allowlist; exclude wins
  lookbackDays: 21,           // how far back to read. A trade, not a knob — see SLACK.md

  // Calendar. Two of the seven signals need one; without it they cannot fire, and
  // "agreed but not booked" can never be settled either.
  calendarId: 'primary',
  useCalendar: true,

  // What it has learned and what you have told it
  mute: [],                   // phrases never worth raising
  unmute: [],                 // overrides anything it muted on its own

  // The digest
  actionList: 5,              // moves in the short list at the top. 0 turns it off
  spotCheck: 5,               // messages sampled to ask what it missed. 0 turns it off

  // The ledger
  ledger: 'ledger.json',
  keepLedgerDays: 90,
  storeText: true,            // false keeps keys and verdicts but not the words

  tzOffset: 0                 // minutes from UTC, for turning Slack timestamps into days
};

/* Later sources win. Config beats the built-in defaults; whatever the run supplies
 * beats config — which is what makes a one-off "just for today, look back 60 days"
 * possible without editing the file. */
function merge() {
  var out = {};
  Array.prototype.slice.call(arguments).forEach(function (src) {
    Object.keys(src || {}).forEach(function (k) {
      var v = src[k];
      if (v === undefined) return;
      // One level of nesting, which is all `channels` needs. A config format that
      // recurses is one nobody can predict the merge behaviour of.
      out[k] = (v && typeof v === 'object' && !Array.isArray(v))
        ? merge(out[k] || {}, v)
        : v;
    });
  });
  return out;
}

/* A missing config file is fine — the defaults are a working configuration for anyone
 * who passes their address on the run. A malformed one is not: silently falling back
 * to defaults would quietly read channels somebody had excluded. */
function loadConfig(fs, path) {
  if (!path) return {};
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error('Config at ' + path + ' could not be read (' + e.message +
      '). Fix it rather than deleting it — falling back to defaults would read ' +
      'channels you have excluded.');
  }
}

/* Everything the run needs, in one object, with the reasons a setup is unusable
 * reported together rather than one per attempt. */
function settings(fs, configPath, run) {
  var s = merge(DEFAULTS, loadConfig(fs, configPath), run || {});
  var missing = [];
  if (!s.you) missing.push('"you" — the address messages are outbound from; without it ' +
    'there is no way to tell inbound from outbound');
  if (missing.length) throw new Error('Config is incomplete:\n  ' + missing.join('\n  '));
  s.you = String(s.you).toLowerCase();
  return s;
}

module.exports = { DEFAULTS: DEFAULTS, merge: merge, loadConfig: loadConfig, settings: settings };
