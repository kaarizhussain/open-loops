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

/* Names match exactly, or by prefix with a trailing star: "deals-*". Deliberately not
 * a general pattern language — a scope rule nobody can read at a glance is a scope
 * rule nobody checks. */
function nameMatches(name, pattern) {
  var n = String(name || '').toLowerCase().replace(/^#/, '');
  var p = String(pattern || '').toLowerCase().replace(/^#/, '');
  return p.slice(-1) === '*' ? n.indexOf(p.slice(0, -1)) === 0 : n === p;
}

/* What may be read at all.
 *
 * The runner is handed conversations that were already fetched, so this cannot stop
 * anything reaching it — the caller has to apply the same rules when choosing what to
 * read. It is the second of two checks, for the same reason the Gmail path checks
 * labels twice: the cost of getting it wrong is somebody's private conversation
 * turning up in a list, and one check is not enough for that.
 *
 * `only` is default-deny. `exclude` is default-allow. Neither is a substitute for
 * fetching less in the first place. */
function inScope(name, scope) {
  scope = scope || {};
  var exclude = scope.exclude || [], only = scope.only || [];
  if (exclude.some(function (p) { return nameMatches(name, p); })) return false;
  if (only.length) return only.some(function (p) { return nameMatches(name, p); });
  return true;
}

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
  var byId = {}, roots = {}, skipped = 0;
  (input.conversations || []).forEach(function (c) {
    if (!inScope(c.channel, input.scope)) { skipped++; return; }
    parseChannel(c.text, {
      channel: c.channel, members: c.members || [], tzOffset: input.tzOffset || 0
    }).forEach(function (m) {
      byId[m.id] = m;
      if (m.hasThread) roots[m.id] = c.channel;   // has replies a channel read omits
    });
  });

  /* Thread replies are a separate fetch — a channel read does not contain them, so a
   * promise made inside a thread is invisible without this.
   *
   * These override rather than append: a thread read repeats its own root message,
   * and the root belongs to the thread rather than to the channel it sits in. Keying
   * the whole thread on the root's timestamp gives closure matching a real boundary,
   * the only one Slack offers that is as tight as an email thread's. */
  (input.threads || []).forEach(function (t) {
    // A thread inherits its channel's scope — excluding #hr and then reading a thread
    // inside it would be an exclusion that does not exclude.
    if (!inScope(t.channel, input.scope)) { skipped++; return; }
    parseChannel(t.text, {
      channel: t.channel, members: t.members || [], threadId: t.root,
      tzOffset: input.tzOffset || 0
    }).forEach(function (m) { byId[m.id] = m; });
    delete roots[t.root];
  });

  var messages = Object.keys(byId).map(function (k) { return byId[k]; })
    .sort(function (a, b) { return parseFloat(a.id) - parseFloat(b.id); });

  /* How far back to look.
   *
   * An unthreaded channel has no conversation boundary of its own, so this window is
   * the only thing bounding closure matching there: read three weeks, and a delivery
   * can only be confused with a promise from the same three weeks. Without it that
   * claim was just a sentence in the documentation.
   *
   * ponytail: the window is a real trade, not a free knob. Anything that ages out is
   * no longer detected, and the ledger reads "no longer detected" as cleared — so too
   * short a window quietly reports long-silent promises as done, which is the failure
   * this whole thing exists to prevent. Widen before narrowing. */
  var window = input.lookbackDays || 0;
  if (window) {
    var cut = new Date(new Date(today + 'T00:00:00Z') - window * 864e5).toISOString().slice(0, 10);
    messages = messages.filter(function (m) { return m.date.slice(0, 10) >= cut; });
  }

  // Roots whose replies nobody fetched. Saying so beats a digest that looks complete.
  var unfetched = Object.keys(roots);

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
    read: { threads: (input.conversations || []).length - skipped, capped: false,
            unfetchedThreads: unfetched.length, skipped: skipped, windowDays: window }
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

module.exports = { main: main, marksFromDm: marksFromDm, inScope: inScope, nameMatches: nameMatches };
