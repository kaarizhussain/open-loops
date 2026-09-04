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
var { parseEvents } = require('./src/calendar.js');
var { settings } = require('./src/config.js');

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
 * `include` is default-deny. `exclude` is default-allow. Neither is a substitute for
 * fetching less in the first place.
 *
 * This read `scope.only` for months while config.js, the example file and SLACK.md all
 * named the setting `include` — so an allowlist somebody wrote to narrow what gets read
 * silently narrowed nothing, and every channel handed to the runner was read. The
 * failure direction is the bad one for a scope rule: it reads more than asked, quietly,
 * and looks like it worked. `only` stays accepted so anyone who found it in the source
 * is not broken by the correction. */
function inScope(name, scope) {
  scope = scope || {};
  var exclude = scope.exclude || [], include = scope.include || scope.only || [];
  if (exclude.some(function (p) { return nameMatches(name, p); })) return false;
  if (include.length) return include.some(function (p) { return nameMatches(name, p); });
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
  var misses = [], checked = 0, ignored = [], counted = {};
  seen.forEach(function (id) { known[id] = 1; });

  messages.forEach(function (m) {
    var head = m.body.match(DIGEST_HEADER);
    if (head) { forDate = head[1]; return; }      // this is a digest, not a reply to one
    if (!forDate || known[m.id]) return;

    var keys = store.recallDigest(forDate);
    var asked = store.audit().asked[forDate] || [];
    if (!keys.length && !asked.length) return;    // no memo for that digest

    known[m.id] = 1;
    seen.push(m.id);

    var marks = L.parseMarks(m.body, keys.length);
    marked += L.applyMarks(rows, keys, marks);
    /* A reply that named an item but did not lead with the number is a note, not a
     * correction. Saying so is what makes it safe to be strict — the reader finds out
     * the same evening instead of retyping it all week. */
    ignored = ignored.concat(marks.ignored || []);

    /* Answering the spot check at all is what makes it evidence. A reply that names
     * no misses still counts everything asked as checked-and-clean; without that the
     * denominator only ever grows when something was wrong, and the rate is garbage. */
    /* Once per digest, not once per reply.
     *
     * The sample belongs to the digest. Two messages underneath one digest are two
     * replies to the same question, and counting the sample again for the second one
     * inflates the denominator and flatters recall — most easily by answering the spot
     * check and then typing anything else at all. */
    if (asked.length && !counted[forDate]) {
      counted[forDate] = 1;
      checked += asked.length;
      marks.missed.forEach(function (letter) {
        var at = letter.charCodeAt(0) - 97;
        if (asked[at]) misses.push({ id: asked[at], on: forDate });
      });
    }
  });

  return { marked: marked, seen: seen, misses: misses, checked: checked, ignored: ignored };
}

/* How it has been doing, out of the ledger alone — no fetching, no input file.
 *
 * Three numbers because they answer different questions. Precision says whether the
 * list can be trusted. Novelty says whether it is worth reading: someone with a good
 * memory could get a flawless digest every morning and gain nothing from it, and
 * precision alone would call that a success. Recall says how much it walked past,
 * which nothing else here can see. */
function report(ledgerPath) {
  var store = fileStore(ledgerPath);
  var rows = store.readLedger();
  var p = L.precision(rows);
  var audit = store.audit();
  var out = ['OPEN LOOPS — how it has been doing', '', 'Tracked ' + p.total + ' items.'];

  if (p.total) {
    var trust = Math.round((1 - p.wrong / p.total) * 100);
    var value = Math.round(p.news / p.total * 100);
    out.push('');
    out.push('  ' + p.wrong + ' wrong          → ' + trust + '% held up' +
      (trust < 80 ? '   under the bar. Fix it or stop.' : ''));
    out.push('  ' + p.knew + ' already known');
    out.push('  ' + p.news + ' genuinely new  → ' + value + '% told you something');
    out.push('');
    out.push(trust >= 80 && value >= 20 ? "Worth someone's morning."
      : trust < 80 ? 'Not trusted enough yet — the wrong-rate is what to fix first.'
      : 'Accurate, but mostly telling you things you knew. Look further back, or rank'
        + ' differently, before adding anything.');
  }

  /* audit.quiet is how big the silent pool was when the last digest ran. Without it
     the extrapolation collapses and the report reads far higher than the digest does
     off the same ledger. Old ledgers have no such field; fall back rather than crash,
     and the next digest run writes one. */
  /* Both from the last digest, never the cumulative row count. p.total grows every
     day the tool is used, so pairing it with a single run's silent pool made recall
     climb on its own — 68% at five rows, 99% at two hundred, same detector throughout.
     Old ledgers carry neither field; fall back rather than crash, and the next digest
     writes both. */
  var r = L.recall(audit.found || p.total, audit.quiet || audit.checked,
                   audit.checked, audit.missed.length);
  out.push('');
  out.push(audit.checked
    ? 'Recall: about ' + r.rate + '% — ' + audit.missed.length + ' misses found in ' +
      audit.checked + ' spot-checked messages.'
    : 'Recall: unmeasured. Nothing has been spot-checked yet, so nothing here says'
      + ' anything about what it walked past.');

  out.push('', 'By signal — real/total, and how many of those were news:');
  Object.keys(p.byType).sort().forEach(function (t) {
    var b = p.byType[t];
    out.push('  ' + (LABEL[t] || t) + ': ' + (b.total - b.wrong) + '/' + b.total +
      '  (' + (b.total - b.wrong - b.knew) + ' new)');
  });

  var learned = store.learnedMutes();
  if (learned.length) {
    /* Say where these came from. They are literal runs of words lifted out of the
     * reader's own messages — that is how mute learning works — and this report is the
     * one thing they are likely to paste to somebody else, because it is the only
     * output that is otherwise pure numbers. Somebody sending "how has it been doing"
     * to a colleague should not discover afterwards that a client name went with it. */
    out.push('', 'Muting on its own — these are phrases from your own messages:');
    out.push('  ' + learned.map(function (m) { return '"' + m.phrase + '"'; }).join(', '));
  }

  out.push('', 'Unmarked rows count as both correct and new, so this reads optimistically.');
  return out.join('\n');
}

function main(argv) {
  var flag = function (name, fallback) {
    var i = argv.indexOf('--' + name);
    return i > -1 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  var configPath = flag('config', 'openloops.config.json');

  if (argv[0] === '--report') {
    var rc = settings(fs, configPath, { you: 'report@localhost' });
    return report(flag('ledger', rc.ledger));
  }
  var inputPath = argv[0];
  if (!inputPath) {
    console.error('usage: node slack-run.js input.json [--config openloops.config.json]');
    console.error('       node slack-run.js --report [--config openloops.config.json]');
    process.exit(2);
  }

  /* Settings and the run are separate things. Who you are and what may be read is
   * stable and belongs in a file; the conversations fetched this morning are not.
   * `self` is still accepted on the run for the sake of anything that passed it
   * before there was anywhere else to put it. */
  var input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  var cfg = settings(fs, configPath, {
    you: input.self || input.you,
    supporting: input.principals || input.supporting,
    channels: input.scope,
    lookbackDays: input.lookbackDays,
    mute: input.mute, unmute: input.unmute,
    spotCheck: input.spotCheck, actionList: input.actionList,
    storeText: input.storeText, keepLedgerDays: input.keepLedgerDays,
    tzOffset: input.tzOffset
  });

  var self = cfg.you;
  var today = flag('today', input.today || new Date().toISOString().slice(0, 10));
  var store = fileStore(flag('ledger', cfg.ledger));

  /* Every conversation becomes messages in the shape loops.js already takes. The
   * channel name stands in for a subject line, which Slack does not have. */
  var byId = {}, roots = {}, skipped = 0, skippedThreads = 0;
  (input.conversations || []).forEach(function (c) {
    if (!inScope(c.channel, cfg.channels)) { skipped++; return; }
    parseChannel(c.text, {
      channel: c.channel, members: c.members || [], tzOffset: cfg.tzOffset,
      self: cfg.you, selfUid: cfg.selfDm
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
    if (!inScope(t.channel, cfg.channels)) { skippedThreads++; return; }
    parseChannel(t.text, {
      channel: t.channel, members: t.members || [], threadId: t.root,
      tzOffset: cfg.tzOffset, self: cfg.you, selfUid: cfg.selfDm
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
  var window = cfg.lookbackDays;
  var cut = null, shortRead = [];
  if (window) {
    cut = new Date(new Date(today + 'T00:00:00Z') - window * 864e5).toISOString().slice(0, 10);

    /* Which conversations did not go back far enough.
     *
     * The fetch reads a fixed number of newest messages, so a busy channel returns
     * three days where the window asks for three weeks. Everything older is simply
     * absent — and absence is what this reads as CLEARED. A promise made a fortnight
     * ago in an active channel would be announced as done, by a tool whose entire
     * purpose is catching the thing nobody finished.
     *
     * There is no flag saying a read was truncated, but there is evidence: if the
     * oldest message a conversation returned is newer than the window start, that
     * conversation was either silent before then or cut short, and the two are
     * indistinguishable from here. Say so rather than guess. */
    var oldestIn = {};
    messages.forEach(function (m) {
      var ch = m.subject || '?', d = m.date.slice(0, 10);
      if (!oldestIn[ch] || d < oldestIn[ch]) oldestIn[ch] = d;
    });
    Object.keys(oldestIn).sort().forEach(function (ch) {
      if (oldestIn[ch] > cut) shortRead.push({ channel: ch, from: oldestIn[ch] });
    });

    messages = messages.filter(function (m) { return m.date.slice(0, 10) >= cut; });
  }

  // Roots whose replies nobody fetched. Saying so beats a digest that looks complete.
  var unfetched = Object.keys(roots);

  var rows = store.readLedger();

  // Yesterday's corrections land before today's list is built, or a rejected item
  // shows up one more time before disappearing.
  var dmMessages = input.dm ? parseChannel(input.dm.text,
    { channel: 'DM', tzOffset: cfg.tzOffset, self: cfg.you, selfUid: cfg.selfDm }) : [];
  var replies = marksFromDm(dmMessages, store, rows);

  /* Phrases you have decided are never worth surfacing. Applied before the ledger
   * sees anything, so a muted item is not "suppressed" — it never becomes an item at
   * all, and does not sit in the ledger being counted as a false positive forever. */
  /* Two of the seven signals live in the gap between what was said and what is on
   * the calendar. Without this they cannot fire at all — and 'agreed but not booked'
   * can never be settled, so it over-reports every agreement forever. */
  var events = parseEvents(input.events);

  var opts = { exec: self, today: today, contacts: input.contacts || null,
               // Absent means the historical single unnamed executive; [] means you
               // support nobody, which is the common case for someone running this
               // over their own account.
               principals: cfg.supporting,
               // Learned from what has cleared before — nobody records this.
               tempo: L.tempos(rows, 3, cfg.lookbackDays) };
  var result = loops.detectLoops(messages, events, opts);

  /* What has been muted: what you configured, plus what the tool concluded on its own,
   * minus anything you overruled. `unmute` always wins — a rule the tool taught itself
   * has to be undoable by one line, or it is not really reversible. */
  var overruled = (cfg.unmute || []).map(function (s) { return String(s).toLowerCase(); });
  var learned = store.learnedMutes().filter(function (e) {
    return overruled.indexOf(e.phrase) === -1;
  });
  var mutes = (cfg.mute || []).concat(learned.map(function (e) { return e.phrase; }));

  /* Snapshot before anything is muted or suppressed. A message whose item you rejected
   * is not one the detector was silent about — it spoke and you disagreed — so it must
   * never come back as "found nothing here, did I miss something?". */
  var spoke = {};
  result.open.concat(result.closed).forEach(function (l) { if (l.msgId) spoke[l.msgId] = 1; });

  var beforeMute = result.open.length;
  var kept = L.applyMutes(result.open, mutes);
  /* Which keys the mute removed, so the ledger can be told.
   *
   * Without this it sees them missing from today's list and announces them under
   * CLEARED SINCE THE LAST RUN — the one section that is unambiguously good news,
   * reporting work nobody did. Muting an item is the reader saying it was never real.
   * That is the opposite of it being finished, and the two must not read the same. */
  var keptKeys = {};
  kept.forEach(function (l) { keptKeys[loops.loopKey(l)] = 1; });
  var mutedKeys = result.open
    .filter(function (l) { return !keptKeys[loops.loopKey(l)]; })
    .map(function (l) { return loops.loopKey(l); });
  result.open = kept;
  var muted = beforeMute - result.open.length;

  /* Learn from what has been rejected since last time.
   *
   * The bar is deliberately higher than for a suggestion: four rejections of the same
   * phrase, and it must appear in nothing that was kept. Once muted, matching items
   * stop becoming rows — so no further evidence accumulates either way, and a wrong
   * mute would never argue itself back. That asymmetry is why the threshold is high,
   * why every one is announced, and why they are listed in every digest afterwards
   * rather than quietly taking effect. */
  var already = {};
  mutes.forEach(function (p) { already[String(p).toLowerCase()] = 1; });
  store.learnedMutes().forEach(function (e) { already[e.phrase] = 1; });

  var fresh = L.suggestMutes(rows, 4)
    .filter(function (s) { return !already[s.phrase]; })
    .map(function (s) { return { phrase: s.phrase, count: s.count, since: today }; });

  var ledger = L.mergeLedger(rows, result.open, today,
                             { storeText: cfg.storeText !== false, mutedKeys: mutedKeys });
  result.open = ledger.shown;
  L.pruneLedger(rows, today, cfg.keepLedgerDays);

  var keys = digest.digestOrder(result.open);

  /* Sample the silence. Everything else in this loop asks about things that appeared;
   * this is the only question that can say anything about what did not. */
  var audit = store.audit();
  var checkCount = cfg.spotCheck;
  var silent = messages.filter(function (m) { return !spoke[m.id]; });
  var sample = L.sampleQuiet(silent, [], checkCount, today);
  /* Both halves have to come from the same read.
   *
   * `found` was the cumulative ledger row count while `quiet` was one day's silent
   * pool, so the ratio drifted upward on its own: identical detector, identical spot
   * check, identical single miss, and recall read 68% at five rows and 99% at two
   * hundred. A number that gets prettier the longer you use it is worse than no number,
   * because it looks like progress.
   *
   * So: how many commitments this read produced, against how many messages in the same
   * read produced nothing. Closed items count as found — recall is about whether the
   * detector saw the commitment, not about whether it is still outstanding. */
  var foundToday = result.open.length + result.closed.length;
  var score = L.recall(foundToday, silent.length,
                       audit.checked + replies.checked, audit.missed.length + replies.misses.length);

  /* Slack refuses a message over 4,000 characters, and a busy mailbox goes miles past
   * it — three Enron mailboxes rendered at 14k, 29k and 29k. That is not a long digest,
   * it is a digest that never arrives, and the runner is right to post nothing rather
   * than half of one, so the reader would have got silence on their first day.
   *
   * The limit belongs to Slack, so the fitting belongs here rather than in the
   * renderer. Shrink the lists until it fits, and let the renderer say what it held
   * back. Starts generous, because most workspaces never come near the ceiling. */
  var SLACK_LIMIT = 4000, FENCE = 8;      // the ``` wrapper the digest is posted inside
  var text, listCap = 12;
  do {
    text = renderAt(listCap);
    listCap = listCap > 4 ? listCap - 4 : listCap - 1;
  } while (text.length + FENCE > SLACK_LIMIT && listCap >= 1);
  /* Measured across sixteen real mailboxes: the worst fits at 2 with 18% to spare and
   * at 1 with 34%. If a mailbox ever exhausts even that, the fixed parts are the cause
   * — the header, the first-moves block with its drafted notes, the spot check — and
   * the honest thing is to say the digest was too long rather than post one Slack will
   * reject and leave the reader with silence. */
  if (text.length + FENCE > SLACK_LIMIT) {
    text += '\n\nTOO LONG — this is ' + (text.length + FENCE) + ' characters and Slack ' +
      'takes 4000. Nothing was dropped to make it fit; the list is already at its ' +
      'smallest. Narrow the channels or shorten the window.';
  }

  function renderAt(cap) {
  return digest.render({
    today: today, source: 'slack', listCap: cap,
    messages: messages, events: events, result: result,
    /* Regrouped by upcoming meeting: the list answers "what is outstanding", and an
     * assistant is asked "what do I need before this". Same items, read the way you
     * read them the night before. Built and unused until there was a calendar. */
    briefs: loops.meetingBriefs(messages, events, result.open, opts),
    ledger: ledger, marked: replies.marked, principals: cfg.supporting,
    muted: muted, mutes: L.suggestMutes(rows).filter(function (s) { return !already[s.phrase]; }),
    learnedNow: fresh, learnedAll: learned,
    spotCheck: sample, recall: score, dark: result.dark, ignoredReplies: replies.ignored,
    /* Conversations skipped, not threads. One counter served both, and only the
       conversation count was reduced by it — so skipping a thread under-reported how
       much was read, and enough of them printed a negative number of conversations. */
    read: { threads: (input.conversations || []).length - skipped,
            capped: shortRead.length > 0, shortRead: shortRead,
            windowStart: cut,
            unfetchedThreads: unfetched.length,
            skipped: skipped + skippedThreads, windowDays: window }
  });
  }

  // --dry renders without recording the run, so the digest can be read by hand
  // before the first real one goes out and consumes the "new" flags.
  if (argv.indexOf('--dry') === -1) {
    store.writeLedger(rows);
    store.rememberDigest(today, keys);
    store.rememberReplies(replies.seen);
    if (fresh.length) store.remember(fresh);
    if (replies.checked || replies.misses.length) {
      store.recordMisses(replies.misses, replies.checked);
    }
    if (sample.length) {
      store.rememberAudit(today, sample.map(function (m) { return m.id; }), silent.length, foundToday);
    }
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
