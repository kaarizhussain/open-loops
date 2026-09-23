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
 *       { "channel": "#deals", "members": [], "text": "<connector output>" }
 *       // members only for a DM: one other member means every item is theirs
 *     ],
 *     "dm": { "channel": "D0123", "text": "<connector output for your self-DM>" }
 *   }
 *
 * The self-DM is where the digest gets posted and where corrections come back. Both
 * directions of that conversation are you, so a digest is told from a reply by the
 * only thing that reliably distinguishes them: digests start with a known header.
 */
var fs = require('fs');
var crypto = require('crypto');
var loops = require('./src/loops.js');
var L = require('./src/ledger.js');

// The renderer and the ledger read these as free variables, the same way they do
// inside Apps Script where every file shares one global scope.
global.OWNER = loops.OWNER;
global.LABEL = loops.LABEL;
global.loopKey = loops.loopKey;

var digest = require('./src/digest.js');
var { readConversation } = require('./src/slack-json.js');
var { coverage, emptyResponse } = require('./src/slack-coverage.js');
var { fileStore } = require('./src/store.js');
var { parseEvents } = require('./src/calendar.js');
var { settings } = require('./src/config.js');

var DIGEST_HEADER = /^\s*(?:```)?\s*OPEN LOOPS — for (\d{4}-\d{2}-\d{2})(?:[^\n]*· ref ([0-9a-f]{4})\b)?/;
// The details the runner posts in the digest's thread. Its instructions contain "3 7".
var DETAILS_HEADER = /^\s*(?:```)?\s*OPEN LOOPS DETAILS\b/;

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
  var seen = store.seenReplies(), known = {}, marked = 0, wrong = 0, knew = 0, cur = null;
  var misses = [], checked = 0, ignored = [], counted = {}, foreign = [], dates = [];
  var since = store.refsSince ? store.refsSince() : null;
  seen.forEach(function (id) { known[id] = 1; });

  messages.forEach(function (m) {
    // Its own details, posted under the digest — not a reply, whatever "3 7" it contains.
    if (DETAILS_HEADER.test(m.body)) return;
    var head = m.body.match(DIGEST_HEADER);
    if (head) {                                    // this is a digest, not a reply to one
      dates.push(head[1]);
      cur = digestMemo(head[1], head[2] || null, store, since);
      return;
    }
    if (!cur || known[m.id]) return;
    var forDate = cur.date, keys = cur.keys, asked = cur.asked;

    /* Under a digest this ledger did not produce. Its numbers belong to somebody else's
     * list — on 2026-09-22 a "k 4" meant for another setup's #4 marked this one's #4 —
     * so nothing is applied, and the reader is told once. */
    if (cur.foreign) {
      known[m.id] = 1;
      seen.push(m.id);
      foreign.push({ text: m.body.trim().split('\n')[0], date: forDate, ref: cur.ref });
      return;
    }
    if (!keys.length && !asked.length) return;    // no memo for that digest

    known[m.id] = 1;
    seen.push(m.id);

    var marks = L.parseMarks(m.body, keys.length);
    [].concat(marks.wrong || [], marks.knew || []).forEach(function (i) {
      var key = keys[i - 1];
      if (key && !rows.some(function (r) { return L.cell(r[L.COL.key]) === key; })) {
        rows.push(L.placeholderRow(key, forDate));
      }
    });
    var w = L.applyMarks(rows, keys, { wrong: marks.wrong });
    var k = L.applyMarks(rows, keys, { knew: marks.knew });
    wrong += w; knew += k; marked += w + k;
    /* A reply that named an item but did not lead with the number is a note, not a
     * correction. Saying so is what makes it safe to be strict — the reader finds out
     * the same evening instead of retyping it all week. */
    ignored = ignored.concat(marks.ignored || []);

    /* A reply that names no misses still counts everything asked as checked-and-clean,
     * because without the clean ones the denominator only grows when something was
     * wrong and the rate is garbage. But it has to BE an answer — a `miss` line, which
     * bare means "none of these".
     *
     * Any reply used to count. So rejecting an item, or typing a note to yourself in
     * your own DM, recorded that the whole sample had been reviewed and nothing
     * missed — and with no misses the estimate is found/(found+0), a flat 100%. Two
     * weeks of replying to anything reported perfect recall on a spot check nobody had
     * ever answered, and made the honest "unmeasured" state unreachable after the first
     * reply. Recall is the one thing here no other number can see, so inventing it is
     * worse than leaving it blank.
     *
     * Once per digest, not once per reply. The sample belongs to the digest, and two
     * messages under one digest are two replies to the same question — counting it
     * twice inflates the denominator and flatters the rate. */
    if (asked.length && marks.answered && !counted[cur.id]) {
      counted[cur.id] = 1;
      checked += asked.length;
      marks.missed.forEach(function (letter) {
        var at = letter.charCodeAt(0) - 97;
        if (asked[at]) misses.push({ id: asked[at], on: forDate });
      });
    }
  });

  return { marked: marked, wrong: wrong, knew: knew, seen: seen, misses: misses, checked: checked,
           ignored: ignored, foreign: foreign, dates: dates };
}

/* Which numbered list a digest header refers to.
 *
 * By its reference when it has one. Without one it is either from before references
 * existed — resolved by date, as it always was — or, dated after this ledger started
 * printing them, from something else writing into the DM. */
function digestMemo(date, ref, store, since) {
  if (ref) {
    var memo = store.recallRef ? store.recallRef(ref) : null;
    return memo ? { id: ref, ref: ref, date: date, keys: memo.keys || [], asked: memo.asked || [] }
                : { id: ref, ref: ref, date: date, foreign: true };
  }
  if (since && date >= since) return { id: date, ref: null, date: date, foreign: true };
  return { id: date, ref: null, date: date, keys: store.recallDigest(date),
           asked: store.audit().asked[date] || [] };
}

// Short: it only has to tell apart the few digests one DM read can contain.
function digestRef(date, keys, asked) {
  return crypto.createHash('sha1').update([date].concat(keys, ['--'], asked).join('\n'))
    .digest('hex').slice(0, 4);
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
    tzOffset: input.tzOffset,
    /* Relationship tiers. This was read from the run's input alone, which nothing in the
     * shipped setup ever writes — so a tier set in the config was accepted, silently
     * ignored, and the whole feature was unreachable through normal use. Config now,
     * with the run still able to add or override entries for a one-off. */
    contacts: input.contacts
  });

  var self = cfg.you;
  var today = flag('today', input.today || new Date().toISOString().slice(0, 10));
  var store = fileStore(flag('ledger', cfg.ledger));
  store.beginRun(today);    // a second run today starts from before the first
  if (cfg.storeText === false) store.dropText();

  /* Every conversation becomes messages in the shape loops.js already takes. The
   * channel name stands in for a subject line, which Slack does not have. */
  var byId = {}, roots = {}, skipped = 0, skippedThreads = 0, unread = [];
  var window = cfg.lookbackDays;
  var cut = window ? new Date(new Date(today + 'T00:00:00Z') - window * 864e5).toISOString().slice(0, 10) : null;
  var sourceCoverage = {}, coverageParent = {}, coverageLabel = {};
  var shortRead = [], confirmedEmpty = 0;
  function recordCoverage(source, key, got, parent, label) {
    var read = coverage(source, cut, cfg.tzOffset);
    if (!got.length && !emptyResponse(source)) {
      read = { state: 'unknown', reason: 'the response could not be parsed' };
    }
    // Duplicate source entries cannot override an uncertain fetch. Pages belong in pages[].
    if (!sourceCoverage[key] || sourceCoverage[key].state === 'complete') sourceCoverage[key] = read;
    coverageParent[key] = parent || null;
    coverageLabel[key] = label || key;
    return read;
  }
  /* A model writes this file, and models vary the shape — one conversation as an object
   * rather than a list of one. [].concat takes both, so a shape slip no longer kills the
   * unattended run before it can say anything at all. */
  var convs = [].concat(input.conversations || []), threadsIn = [].concat(input.threads || []);
  convs.forEach(function (c) {
    if (!inScope(c.channel, cfg.channels)) { skipped++; return; }
    var got = readConversation(c, {
      channel: c.channel, members: c.members || [], tzOffset: cfg.tzOffset,
      self: cfg.you, selfUid: cfg.selfUid || cfg.selfDm, users: input.users
    });
    /* Handed over and nothing came out. A fetch that failed and a channel nobody has
     * posted in look identical from here, so this does not claim which — but the two
     * are worth different reactions and only one of them is fine, and saying nothing
     * lets the bad one pass as the good one. */
    var read = recordCoverage(c, c.channel, got, null, c.channel);
    if (!got.length) {
      if (read.state === 'complete' && emptyResponse(c)) confirmedEmpty++;
      else unread.push(c.channel);
    }
    got.forEach(function (m) {
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
  threadsIn.forEach(function (t) {
    // A thread inherits its channel's scope — excluding #hr and then reading a thread
    // inside it would be an exclusion that does not exclude.
    if (!inScope(t.channel, cfg.channels)) { skippedThreads++; return; }
    var repliesRead = readConversation(t, {
      channel: t.channel, members: t.members || [], threadId: t.root,
      tzOffset: cfg.tzOffset, self: cfg.you, selfUid: cfg.selfUid || cfg.selfDm, users: input.users
    });
    repliesRead.forEach(function (m) { byId[m.id] = m; });
    var read = recordCoverage(t, t.root, repliesRead, t.channel,
      t.channel + ' thread ' + t.root);
    if (repliesRead.length) delete roots[t.root];
    if (!repliesRead.length) unread.push(t.channel + ' thread ' + t.root);
  });

  var messages = Object.keys(byId).map(function (k) { return byId[k]; })
    .sort(function (a, b) { return parseFloat(a.id) - parseFloat(b.id); });

  // Coverage comes from fetch evidence, never from a phrase in a Slack message or
  // from the date of the oldest message that happened to be returned.
  Object.keys(sourceCoverage).sort().forEach(function (key) {
    var read = sourceCoverage[key];
    var parent = coverageParent[key];
    if (read.state !== 'complete' &&
        !(parent && sourceCoverage[parent] && sourceCoverage[parent].state !== 'complete')) {
      shortRead.push({ channel: coverageLabel[key], reason: read.reason });
    }
  });
  if (cut) messages = messages.filter(function (m) { return m.date.slice(0, 10) >= cut; });

  // Roots whose replies nobody fetched. Saying so beats a digest that looks complete.
  var unfetched = Object.keys(roots);

  var rows = store.readLedger();

  // Yesterday's corrections land before today's list is built, or a rejected item
  // shows up one more time before disappearing.
  var dmMessages = input.dm ? readConversation(input.dm,
    { channel: 'DM', tzOffset: cfg.tzOffset, self: cfg.you, selfUid: cfg.selfUid || cfg.selfDm, users: input.users }) : [];
  /* Replies typed in the digest's thread count too — the details live there, so that is
   * where a reader is when they decide an item is wrong, and a thread reply does not
   * appear in a read of the DM itself. Merged by timestamp; the thread read repeats the
   * digest as its parent, which is kept once.
   *
   * One thread, or several: a re-run reads the thread of today's earlier digest as well
   * as yesterday's, because both may have been answered. */
  var inDm = {};
  dmMessages.forEach(function (m) { inDm[m.id] = 1; });
  [].concat(input.dmThread || []).forEach(function (t) {
    readConversation(t, { channel: 'DM', threadId: t.root, tzOffset: cfg.tzOffset,
      self: cfg.you, selfUid: cfg.selfUid || cfg.selfDm, users: input.users }).forEach(function (m) {
      if (!inDm[m.id]) { inDm[m.id] = 1; dmMessages.push(m); }
    });
  });
  dmMessages.sort(function (a, b) { return parseFloat(a.id) - parseFloat(b.id); });
  var replies = marksFromDm(dmMessages, store, rows);
  /* The read began at today's own digest although there was an earlier one to begin at.
   * Corrections typed under that earlier digest were never handed over, and a re-run
   * starts from before today's first run — so they would silently stop applying. */
  var startedToday = replies.dates.length > 0 &&
    replies.dates.every(function (d) { return d === today; }) &&
    store.digestDates().some(function (d) { return d < today; });

  /* Phrases you have decided are never worth surfacing. Applied before the ledger
   * sees anything, so a muted item is not "suppressed" — it never becomes an item at
   * all, and does not sit in the ledger being counted as a false positive forever. */
  /* Two of the seven signals live in the gap between what was said and what is on
   * the calendar. Without this they cannot fire at all — and 'agreed but not booked'
   * can never be settled, so it over-reports every agreement forever. */
  /* A calendar that failed to fetch arrives as whatever the connector said instead — an
   * error sentence, not JSON — and parsing it threw and took the whole run with it.
   * SKILL.md says to run without the calendar and say so; now the runner actually does. */
  var events, calendarError = null;
  try { events = parseEvents(input.events); }
  catch (e) { events = []; calendarError = e.message; }

  var opts = { exec: self, today: today, contacts: cfg.contacts || null,
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
  /* Nor is a question it is holding back until it is two days old. It found the question
     and chose not to raise it yet; offering it as "found nothing" turns its own restraint
     into a recall miss the moment anyone answers honestly. */
  (result.held || []).forEach(function (id) { spoke[id] = 1; });
  /* Nor is the message that closed something. The digest quotes it under CLOSED ITSELF as
     the evidence; asking a line later whether it found nothing in it contradicts itself. */
  result.closed.forEach(function (l) { if (l.closerId) spoke[l.closerId] = 1; });

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

  var closedKeys = [];
  result.closed.forEach(function (l) {
    closedKeys.push(loops.loopKey(Object.assign({}, l, { type: l.openType })));
    // A scheduling promise is stored under this type until a calendar hold exists.
    if (l.byUs) closedKeys.push(loops.loopKey(Object.assign({}, l, { type: 'agreed_unscheduled' })));
  });
  var ledger = L.mergeLedger(rows, result.open, today,
                             { storeText: cfg.storeText !== false, mutedKeys: mutedKeys,
                               windowStart: cut, closedKeys: closedKeys,
                               availableThreads: Object.keys(sourceCoverage).filter(function (key) {
                                 return sourceCoverage[key].state === 'complete';
                               }),
                               calendarRead: input.events != null && !calendarError });
  result.open = ledger.shown;
  L.pruneLedger(rows, today, cfg.keepLedgerDays);
  // Retention deletion is not completion, and expired rows no longer remain in the ledger.
  var retained = {};
  rows.forEach(function (r) { retained[L.cell(r[L.COL.key])] = true; });
  ['gone', 'aged', 'unknown'].forEach(function (kind) {
    ledger[kind] = ledger[kind].filter(function (item) { return retained[item.key]; });
  });

  var keys = digest.digestOrder(result.open, today);

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
  var ref = digestRef(today, keys, sample.map(function (m) { return m.id; }));
  var foundToday = result.open.length + result.closed.length;
  var score = L.recall(foundToday, silent.length,
                       audit.checked + replies.checked, audit.missed.length + replies.misses.length);

  /* The reply instructions in full until the reader has answered once, then as a key.
   * Any answer counts — a rejection, a k, a spot-check reply — because any of them shows
   * the loop has been learned. The config can pin either. */
  var taught = replies.marked > 0 || replies.checked > 0 || audit.checked > 0 ||
    rows.some(function (r) { return r[L.COL.verdict]; });
  var replyKey = cfg.replyKey || (taught ? 'short' : 'long');

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
  // Two messages now — the brief and its thread reply — so each has to fit on its own.
  var longest = function (t) {
    return Math.max.apply(null, t.split(digest.SPLIT).map(function (x) { return x.trim().length; }));
  };
  do {
    text = renderAt(listCap);
    listCap = listCap > 4 ? listCap - 4 : listCap - 1;
  } while (longest(text) + FENCE > SLACK_LIMIT && listCap >= 1);
  /* Measured across sixteen real mailboxes: the worst fits at 2 with 18% to spare and
   * at 1 with 34%. If a mailbox ever exhausts even that, the fixed parts are the cause
   * — the header, the first-moves block with its drafted notes, the spot check — and
   * the honest thing is to say the digest was too long rather than post one Slack will
   * reject and leave the reader with silence. */
  if (longest(text) + FENCE > SLACK_LIMIT) {
    text += '\n\nTOO LONG — this is ' + (longest(text) + FENCE) + ' characters and Slack ' +
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
    ledger: ledger, marked: replies.marked, markedWrong: replies.wrong, markedKnew: replies.knew,
    ref: ref, foreignReplies: replies.foreign, dmStartedToday: startedToday,
    principals: cfg.supporting,
    muted: muted, mutes: L.suggestMutes(rows).filter(function (s) { return !already[s.phrase]; }),
    learnedNow: fresh, learnedAll: learned,
    spotCheck: sample, recall: score, dark: result.dark, ignoredReplies: replies.ignored,
    replyKey: replyKey,
    /* Conversations skipped, not threads. One counter served both, and only the
       conversation count was reduced by it — so skipping a thread under-reported how
       much was read, and enough of them printed a negative number of conversations. */
    read: { threads: convs.length - skipped, confirmedEmpty: confirmedEmpty,
            capped: shortRead.length > 0, shortRead: shortRead, unread: unread,
            calendarError: calendarError,
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
    store.rememberRef(ref, today, keys, sample.map(function (m) { return m.id; }));
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
