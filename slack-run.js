#!/usr/bin/env node
/* Open Loops over Slack.
 *
 *   node slack-run.js input.json [--ledger ledger.json] [--today YYYY-MM-DD]
 *
 * Reads a dump of Slack conversations, runs the detector over them, folds the result
 * into the ledger, and prints the digest. It does not talk to Slack itself — fetching
 * and posting are the caller's job, which is what keeps the judgement in here
 * deterministic. A model retrieves and delivers; this decides.
 *
 * input.json:
 *   {
 *     "self": "you@example.com",
 *     "today": "2026-09-01",                       // optional, defaults to the clock
 *     "conversations": [
 *       { "channel": "#deals", "members": ["a@b.com"], "text": "<connector output>" }
 *     ],
 *     "dm": { "channel": "D0123", "text": "<connector output for your self-DM>" }
 *   }
 *
 * The self-DM is where the digest gets posted and where corrections come back. Both
 * directions of that conversation are you, so a digest is told from a reply by the
 * only thing that reliably distinguishes them: digests start with a known header.
 */
var fs = require('fs');
var loops = require('./src/loops.js');
var L = require('./src/ledger.js');

// The renderer and the ledger read these as free variables, the same way they do
// inside Apps Script where every file shares one global scope.
global.OWNER = loops.OWNER;
global.LABEL = loops.LABEL;
global.loopKey = loops.loopKey;

var digest = require('./src/digest.js');
var { parseChannel } = require('./src/slack.js');
var { fileStore } = require('./src/store.js');

var DIGEST_HEADER = /^\s*(?:```)?\s*OPEN LOOPS — for (\d{4}-\d{2}-\d{2})/;

/* Corrections, read out of the self-DM.
 *
 * Walks oldest to newest. A digest sets the numbering that anything after it refers
 * to, so an old reply resolves against the list it was actually answering rather than
 * whatever is on screen now. Each reply is acted on once — it stays in the DM
 * forever, and re-applying it against a later, shorter list marks different items. */
function marksFromDm(messages, store, rows) {
  var seen = store.seenReplies(), known = {}, marked = 0, forDate = null;
  seen.forEach(function (id) { known[id] = 1; });

  messages.forEach(function (m) {
    var head = m.body.match(DIGEST_HEADER);
    if (head) { forDate = head[1]; return; }      // this is a digest, not a reply to one
    if (!forDate || known[m.id]) return;

    var keys = store.recallDigest(forDate);
    if (!keys.length) return;                     // no memo for that digest

    known[m.id] = 1;
    seen.push(m.id);
    marked += L.applyMarks(rows, keys, L.parseMarks(m.body, keys.length));
  });

  return { marked: marked, seen: seen };
}

function main(argv) {
  var inputPath = argv[0];
  if (!inputPath) {
    console.error('usage: node slack-run.js input.json [--ledger ledger.json] [--today YYYY-MM-DD]');
    process.exit(2);
  }
  var flag = function (name, fallback) {
    var i = argv.indexOf('--' + name);
    return i > -1 && argv[i + 1] ? argv[i + 1] : fallback;
  };

  var input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  var self = String(input.self || '').toLowerCase();
  if (!self) throw new Error('input.json needs "self" — the address messages are outbound from');

  var today = flag('today', input.today || new Date().toISOString().slice(0, 10));
  var store = fileStore(flag('ledger', 'ledger.json'));

  /* Every conversation becomes messages in the shape loops.js already takes. The
   * channel name stands in for a subject line, which Slack does not have. */
  var messages = [];
  (input.conversations || []).forEach(function (c) {
    messages = messages.concat(parseChannel(c.text, {
      channel: c.channel, members: c.members || [], tzOffset: input.tzOffset || 0
    }));
  });

  var rows = store.readLedger();

  // Yesterday's corrections land before today's list is built, or a rejected item
  // shows up one more time before disappearing.
  var dmMessages = input.dm ? parseChannel(input.dm.text, { channel: 'DM', tzOffset: input.tzOffset || 0 }) : [];
  var replies = marksFromDm(dmMessages, store, rows);

  var opts = { exec: self, today: today, contacts: input.contacts || null,
               // Absent means the historical single unnamed executive; [] means you
               // support nobody, which is the common case for someone running this
               // over their own account.
               principals: input.principals || [] };
  var result = loops.detectLoops(messages, [], opts);

  var ledger = L.mergeLedger(rows, result.open, today, { storeText: input.storeText !== false });
  result.open = ledger.shown;
  L.pruneLedger(rows, today, input.keepLedgerDays || 90);

  var keys = digest.digestOrder(result.open);

  var text = digest.render({
    today: today, source: 'slack',
    messages: messages, events: [], result: result, briefs: [],
    ledger: ledger, marked: replies.marked, principals: input.principals || [],
    read: { threads: (input.conversations || []).length, capped: false }
  });

  // --dry renders without recording the run, so the digest can be read by hand
  // before the first real one goes out and consumes the "new" flags.
  if (argv.indexOf('--dry') === -1) {
    store.writeLedger(rows);
    store.rememberDigest(today, keys);
    store.rememberReplies(replies.seen);
  }

  return text;
}

if (require.main === module) {
  try {
    console.log(main(process.argv.slice(2)));
  } catch (e) {
    console.error('open-loops: ' + e.message);
    process.exit(1);
  }
}

module.exports = { main: main, marksFromDm: marksFromDm };
