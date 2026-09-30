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
var { settings, loadConfig, scopeProblems } = require('./src/config.js');
var outbox = require('./src/outbox.js');
var alerts = require('./src/alerts.js');
var status = require('./src/status.js');
var diag = require('./src/diagnostics.js');
var path = require('path');

var DIGEST_HEADER = /^\s*(?:```)?\s*OPEN LOOPS — for (\d{4}-\d{2}-\d{2})(?:[^\n]*· ref ([0-9a-f]{4})\b)?/;
/* What a run posts under its own digest, besides the digest: the details (whose
 * instructions contain "3 7") and any run notes. Both post as the reader, so only the
 * header tells them from a reply — and a notes line like "3 items aged out" leads with
 * a number, which is a rejection (2026-09-23). A midday alert is the same kind of message.
 * Exact headers only: a reply that merely
 * starts "OPEN LOOPS …" is the reader's, and is read like any other. */
var GENERATED_HEADER = /^\s*(?:```)?\s*OPEN LOOPS (?:DETAILS|NOTES|ALERT|NOT RUN|DELIVERY UNKNOWN) — /;
/* A digest's own lines, wherever they turn up. A digest posted without its header (2026-09-28)
 * is not recognised as one, and its numbered lines — " 1  11d late …" — read as a reply
 * rejecting those items. Recognised by what it says rather than by what it opens with. */
var DIGEST_BODY = /^TODAY — highest priority\s*$|^Reply {2}3 7 not real|^Every open item with the sentence it came from, who said it/m;

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
  // `include || only` never reached `only` through a config: the defaults merge in include: [], which is truthy.
  var exclude = scope.exclude || [], include = scope.include && scope.include.length ? scope.include : scope.only || [];
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
  var misses = [], checked = 0, ignored = [], rejected = [], spot = [], counted = {}, foreign = [], dates = [], byRoot = {}, mass = [], applied = [];
  var since = store.refsSince ? store.refsSince() : null;
  seen.forEach(function (id) { known[id] = 1; });

  messages.forEach(function (m) {
    // Its own details, posted under the digest — not a reply, whatever "3 7" it contains.
    if (GENERATED_HEADER.test(m.body)) return;
    var head = m.body.match(DIGEST_HEADER);
    if (head) {                                    // this is a digest, not a reply to one
      dates.push(head[1]);
      cur = digestMemo(head[1], head[2] || null, store, since);
      byRoot[m.id] = cur;                          // a digest is the root of its own thread
      return;
    }
    if (DIGEST_BODY.test(m.body)) return;          // a digest that lost its header, not a reply

    /* A reply typed in a digest's thread answers THAT digest, whenever it was typed. Reading
     * the newest header before it instead sent a late "1" under yesterday's digest to
     * today's item 1 (found in review, 2026-09-28). Only a reply with no thread of its own
     * is placed by time. One whose parent digest was not read cannot be resolved at all. */
    var inThread = /^\d+\.\d+$/.test(String(m.threadId || ''));
    var memo = inThread ? byRoot[m.threadId] : cur;
    if (!memo || known[m.id]) return;
    var forDate = memo.date, keys = memo.keys, asked = memo.asked;

    /* Under a digest this ledger did not produce. Its numbers belong to somebody else's
     * list — on 2026-09-22 a "k 4" meant for another setup's #4 marked this one's #4 —
     * so nothing is applied, and the reader is told once. */
    if (memo.foreign) {
      known[m.id] = 1;
      seen.push(m.id);
      foreign.push({ text: m.body.trim().split('\n')[0], date: forDate, ref: memo.ref });
      return;
    }
    if (!keys.length && !asked.length) return;    // no memo for that digest

    known[m.id] = 1;
    seen.push(m.id);

    var marks = L.parseMarks(m.body, keys.length);
    /* One reply rejecting most of the list is almost certainly something pasted into the DM,
     * not a correction: a real one is a handful of numbers, and a wrong rejection hides the
     * item from every later digest. Nothing is applied, and the reader is told once. */
    if (marks.wrong.length >= 4 && marks.wrong.length * 2 > keys.length) {
      mass.push({ text: m.body.trim().split('\n')[0], count: marks.wrong.length, of: keys.length, date: forDate });
      return;
    }
    [].concat(marks.wrong || [], marks.knew || []).forEach(function (i) {
      var key = keys[i - 1];
      if (key) applied.push(key);
      if (key && !rows.some(function (r) { return L.cell(r[L.COL.key]) === key; })) {
        rows.push(L.placeholderRow(key, forDate));
      }
    });
    marks.wrong.forEach(function (i) {
      if (keys[i - 1]) rejected.push({ key: keys[i - 1], on: forDate, listed: keys.length });
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
    if (asked.length && marks.answered && !counted[memo.id]) {
      counted[memo.id] = 1;
      checked += asked.length;
      spot.push({ ref: memo.id, on: forDate, sampled: asked.length,
                  missed: marks.missed.filter(function (l) { return asked[l.charCodeAt(0) - 97]; }).length });
      marks.missed.forEach(function (letter) {
        var at = letter.charCodeAt(0) - 97;
        if (asked[at]) misses.push({ id: asked[at], on: forDate });
      });
    }
  });

  return { marked: marked, wrong: wrong, knew: knew, seen: seen, misses: misses, checked: checked,
           ignored: ignored, foreign: foreign, dates: dates, mass: mass, rejected: rejected, spot: spot, applied: applied };
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
  /* An absent DEFAULT config is fine: the defaults are a working setup. A path somebody typed is not —
   * a config that is not there read as "no exclusions and no mutes", so a typo listed the channels the
   * real file excluded. Only the explicit flag stops the run. */
  var explicit = argv.indexOf('--config');
  if (explicit > -1 && !(argv[explicit + 1] && fs.existsSync(argv[explicit + 1]))) {
    throw new Error('--config ' + (argv[explicit + 1] || '(no path)') + ' does not exist. Fix the path, or leave --config ' +
      'off to use ./openloops.config.json: running without the file you meant would read channels it excludes.');
  }

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
    lookbackDays: input.lookbackDays,
    mute: input.mute, unmute: input.unmute,
    spotCheck: input.spotCheck, actionList: input.actionList,
    // Privacy settings are the config's. The run can only turn text storage off, never on.
    storeText: input.storeText === false ? false : undefined, keepLedgerDays: input.keepLedgerDays,
    tzOffset: input.tzOffset,
    /* Relationship tiers. This was read from the run's input alone, which nothing in the
     * shipped setup ever writes — so a tier set in the config was accepted, silently
     * ignored, and the whole feature was unreachable through normal use. Config now,
     * with the run still able to add or override entries for a one-off. */
    contacts: input.contacts
  });

  /* The config decides what may be read. The run's own scope can only narrow it — a run
   * input is assembled from what was fetched, and a channel restriction that fetched text
   * could lift is not a restriction. */
  if (input.scope != null) {
    var bad = scopeProblems(input.scope, 'the run input "scope"');
    if (bad.length) throw new Error('Run input is unusable: ' + bad.join('; '));
  }
  var allowed = function (name) { return inScope(name, cfg.channels) && inScope(name, input.scope); };
  var widenedStore = input.storeText === true && cfg.storeText === false;
  var self = cfg.you;
  var reportDir = path.dirname(path.resolve(configPath));
  outbox.prune(reportDir, cfg);    // diagnostics off: anything still queued is discarded, never sent
  var today = flag('today', input.today || new Date().toISOString().slice(0, 10));
  var store = fileStore(flag('ledger', cfg.ledger));
  store.beginRun(today);    // a second run today starts from before the first
  if (cfg.storeText === false) store.dropText();

  /* Every conversation becomes messages in the shape loops.js already takes. The
   * channel name stands in for a subject line, which Slack does not have. */
  /* A Slack timestamp is unique within a channel, not across the workspace, so two channels can hold different
   * messages with the same one, and two can have a thread with the same root. Every message is therefore
   * identified by its timestamp AND its channel, always — never only when a collision happens to be in this
   * run's input, which would change a message's identity whenever another channel was or was not fetched:
   *   id        <ts>@<channel>          the message; ts keeps the original Slack timestamp
   *   threadId  <root ts>@<channel>     a thread; a channel's own stream is already named by its channel
   * A thread read still replaces its own root because it shares that root's channel. A commitment's
   * ledger key names the channel too. Rows written before that store no channel, so they are matched by
   * reconcileLegacy only when they fit one commitment. */
  var tag = function (m, channel) {
    m.ts = m.id;
    m.id = m.ts + '@' + channel;
    if (!m.stream) m.threadId = m.threadId + '@' + channel;
  };
  var slot = function (channel, ts) { return channel + String.fromCharCode(0) + ts; };
  var byId = {}, roots = {}, skipped = 0, skippedThreads = 0, unread = [], failed = [], orderSuspect = [];
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
    if (!allowed(c.channel)) { skipped++; return; }
    var got;
    try {
      got = readConversation(c, {
        channel: c.channel, members: c.members || [], tzOffset: cfg.tzOffset,
        self: cfg.you, selfUid: cfg.selfUid || cfg.selfDm, users: input.users
      });
    } catch (e) {
      /* One conversation the parser refuses is that conversation's problem. It used to throw out of the
       * whole run, so every other channel went unread too and nothing was posted. It is reported by
       * name, with no coverage recorded, so what it held stays not-verified instead of reading as
       * cleared. The reason goes to stderr: it names a field and a timestamp, never message text. */
      failed.push(c.channel);
      process.stderr.write('open-loops: ' + c.channel + ' was not read: ' + e.message + String.fromCharCode(10));
      return;
    }
    /* Handed over and nothing came out. A fetch that failed and a channel nobody has
     * posted in look identical from here, so this does not claim which — but the two
     * are worth different reactions and only one of them is fine, and saying nothing
     * lets the bad one pass as the good one. */
    if (got.suspect) orderSuspect.push(c.channel);
    var read = recordCoverage(c, c.channel, got, null, c.channel);
    if (!got.length) {
      if (read.state === 'complete' && emptyResponse(c)) confirmedEmpty++;
      else unread.push(c.channel);
    }
    got.forEach(function (m) {
      var ts = m.id;
      tag(m, c.channel);
      byId[m.id] = m;
      if (m.hasThread) roots[slot(c.channel, ts)] = c.channel;   // has replies a channel read omits
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
    if (!allowed(t.channel)) { skippedThreads++; return; }
    var repliesRead;
    try {
      repliesRead = readConversation(t, {
        channel: t.channel, members: t.members || [], threadId: t.root,
        tzOffset: cfg.tzOffset, self: cfg.you, selfUid: cfg.selfUid || cfg.selfDm, users: input.users
      });
    } catch (e) {
      failed.push(t.channel + ' thread ' + t.root);
      process.stderr.write('open-loops: ' + t.channel + ' thread ' + t.root + ' was not read: ' + e.message + String.fromCharCode(10));
      return;
    }
    repliesRead.forEach(function (m) { tag(m, t.channel); byId[m.id] = m; });
    if (repliesRead.suspect) orderSuspect.push(t.channel + ' thread ' + t.root);
    var read = recordCoverage(t, t.root + '@' + t.channel, repliesRead, t.channel,
      t.channel + ' thread ' + t.root);
    if (repliesRead.length) delete roots[slot(t.channel, t.root)];
    if (!repliesRead.length) unread.push(t.channel + ' thread ' + t.root);
  });

  var messages = Object.keys(byId).map(function (k) { return byId[k]; })
    .sort(function (a, b) { return parseFloat(a.ts) - parseFloat(b.ts) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });

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
  /* A same-day re-run starts from before the first run, so a correction applied by the first
   * run is gone unless this run reads that reply again. Say so instead of relisting the item. */
  var carried = {};
  rows.forEach(function (r) { if (L.cell(r[L.COL.verdict])) carried[L.cell(r[L.COL.key])] = 1; });
  var notReapplied = store.discardedVerdicts().filter(function (k) { return !carried[k]; }).length;
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

  /* Rows written before keys named a channel are matched to today's commitments here, once, before anything is
   * muted or merged. A legacy verdict moves only onto a single match and only when every read was complete;
   * otherwise it is preserved as it was (see reconcileLegacy). Replies already applied above land on the legacy
   * key first, so a correction typed under an old digest is carried over with it. */
  var candidates = [];
  result.open.forEach(function (l) { candidates.push({ key: loops.loopKey(l), channel: l.subject }); });
  result.closed.forEach(function (l) {
    candidates.push({ key: loops.loopKey(Object.assign({}, l, { type: l.openType })), channel: l.subject });
    if (l.byUs) candidates.push({ key: loops.loopKey(Object.assign({}, l, { type: 'agreed_unscheduled' })), channel: l.subject });
  });
  var readsOk = failed.length === 0 && unread.length === 0 && shortRead.length === 0 && unfetched.length === 0;
  var rec = L.reconcileLegacy(rows, candidates, { legacyKey: loops.legacyKey, readsOk: readsOk });
  store.migrateKeys(rec.renames);
  var ambiguousLegacy = {};
  rec.ambiguous.forEach(function (a) { ambiguousLegacy[a.legacy] = 1; });
  var ambiguousReplies = Object.keys(replies.applied.reduce(function (o, k) { if (ambiguousLegacy[k]) o[k] = 1; return o; }, {})).length;

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
  /* What a check against the ledger may treat as read. A thread is "<root>@<channel>"; a legacy row names only the
   * root, so a bare root counts as read only if every thread read with that root was complete. */
  var availableThreads = Object.keys(sourceCoverage).filter(function (key) { return sourceCoverage[key].state === 'complete'; });
  var bareRoots = {};
  Object.keys(sourceCoverage).forEach(function (key) {
    var m = /^([0-9.]+)@/.exec(key);
    if (m) bareRoots[m[1]] = bareRoots[m[1]] !== false && sourceCoverage[key].state === 'complete';
  });
  Object.keys(bareRoots).forEach(function (r) { if (bareRoots[r]) availableThreads.push(r); });
  var ledger = L.mergeLedger(rows, result.open, today,
                             { storeText: cfg.storeText !== false, mutedKeys: mutedKeys,
                               windowStart: cut, closedKeys: closedKeys,
                               availableThreads: availableThreads,
                               keepKeys: rec.deferred,
                               calendarRead: input.events != null && !calendarError });
  result.open = ledger.shown;
  L.pruneLedger(rows, today, cfg.keepLedgerDays);
  // Retention deletion is not completion, and expired rows no longer remain in the ledger.
  var retained = {};
  rows.forEach(function (r) { retained[L.cell(r[L.COL.key])] = true; });
  ['gone', 'aged', 'unknown'].forEach(function (kind) {
    ledger[kind] = ledger[kind].filter(function (item) { return retained[item.key]; });
  });

  if (argv.indexOf('--check') > -1) {
    return runCheck({ argv: argv, flag: flag, cfg: cfg, dir: reportDir, today: today, store: store,
                      open: result.open, closed: result.closed, rows: rows, messages: messages });
  }

  /* What this run read, once: the digest renders it, and the status record stages it. */
  var readInfo = { orderSuspect: orderSuspect, widenedStore: widenedStore, threads: convs.length - skipped, confirmedEmpty: confirmedEmpty,
          capped: shortRead.length > 0, shortRead: shortRead, unread: unread, failed: failed,
          calendarError: calendarError,
          windowStart: cut,
          unfetchedThreads: unfetched.length,
          skipped: skipped + skippedThreads, windowDays: window };
  /* After a gap only: the last delivered digest, and the days the recorded schedule expected one. */
  var prevGap = null;
  try { prevGap = fs.existsSync(configPath) ? status.gap(reportDir, today) : null; } catch (e) { /* the status record must never cost the digest */ }
  /* Whether the search for the earlier digest (to re-apply its corrections) reached an answer: tools/dm-lookup.js prints the value.
   * Absent means the input predates it, and nothing is claimed. Anything but found / searched_none is a search that did not finish. */
  var lookup = input.dmLookup == null || input.dmLookup === 'found' || input.dmLookup === 'searched_none' ? null
    : input.dmLookup === 'cannot_page' ? 'cannot_page' : 'failed';

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
    ref: ref, notReapplied: notReapplied, legacyAmbiguous: rec.ambiguous, legacyReplies: ambiguousReplies, foreignReplies: replies.foreign, massReplies: replies.mass, dmStartedToday: startedToday,
    principals: cfg.supporting,
    muted: muted, mutes: L.suggestMutes(rows).filter(function (s) { return !already[s.phrase]; }),
    learnedNow: fresh, learnedAll: learned,
    spotCheck: sample, recall: score, dark: result.dark, ignoredReplies: replies.ignored,
    replyKey: replyKey, gapLine: status.gapLine(prevGap), dmLookup: lookup,
    /* Conversations skipped, not threads. One counter served both, and only the
       conversation count was reduced by it — so skipping a thread under-reported how
       much was read, and enough of them printed a negative number of conversations. */
    read: readInfo
  });
  }

  // --dry renders without recording the run, so the digest can be read by hand
  // before the first real one goes out and consumes the "new" flags.
  if (argv.indexOf('--dry') === -1) {
    store.writeLedger(rows);
    store.rememberDigest(today, keys);
    store.rememberRef(ref, today, keys, sample.map(function (m) { return m.id; }));
    store.rememberReplies(replies.seen);
    /* What this digest showed, for the next midday check to compare against. Staged, not
     * written: nothing has been posted yet, and the baseline is what the reader was shown.
     * tools/alerts.js --baseline --ref <ref> promotes it once the digest is read back. Kept for
     * everyone — a small file of keys and levels, inert until they opt in — and it must never
     * cost the digest. Beside a config only: a run with none has nowhere to keep it, and must
     * not litter the working directory. */
    if (fs.existsSync(configPath)) {
      try { alerts.stageBaseline(reportDir, result.open, today, ref); } catch (e) { /* the next digest stages it */ }
      /* What this digest read, for the status record. Staged like the baseline: it becomes "last delivered" only
       * when tools/status.js --end says the digest posted and verified. Never at the digest's cost. */
      try {
        status.stage(reportDir, { ref: ref, date: today, read: status.readFacts(readInfo, messages.length),
          channels: convs.filter(function (c) { return allowed(c.channel); }).map(function (c) { return c.channel; }),
          conversations: readInfo.threads, messages: messages.length, meetings: (events || []).length, windowDays: window });
      } catch (e) { /* the next digest stages it */ }
    }
    if (fresh.length) store.remember(fresh);
    if (replies.checked || replies.misses.length) {
      store.recordMisses(replies.misses, replies.checked);
    }
    queueReports(reportDir, cfg, replies, rows);
    if (sample.length) {
      store.rememberAudit(today, sample.map(function (m) { return m.id; }), silent.length, foundToday);
    }
  }

  return text;
}

/* A midday check. Reads the ledger and writes only alerts.json. Prints the alert to post, or a
 * line saying why there is none. The gate (tools/alerts.js --which) decides whether to fetch at
 * all; this decides again, because a run that was not gated must not alert out of hours. */
function runCheck(o) {
  var cfg = o.cfg, slot = o.flag('slot', '');
  if (!alerts.consent(cfg)) return 'ALERTS OFF — nothing was compared or written.';
  if (!slot) throw new Error('--check needs --slot HH:MM (the check time tools/alerts.js --which printed)');
  var now = alerts.parseNow(o.flag('now', ''));
  var want = alerts.decide(cfg, now, o.dir);
  if (want.run !== 'CHECK' || want.slot !== slot) {
    return 'SKIP — ' + (want.run === 'CHECK' ? 'the ' + want.slot + ' check is due, not ' + slot : want.reason) + '.';
  }
  // The detector's idea of overdue and due today is relative to the date it was given.
  if (o.today !== want.date) {
    throw new Error('--check needs --today ' + want.date + ' (the local date tools/alerts.js --which printed), got ' + o.today);
  }
  var verdict = {};
  o.rows.forEach(function (r) { verdict[L.cell(r[L.COL.key])] = L.cell(r[L.COL.verdict]); });
  var text = alerts.check(o.dir, cfg, {
    slot: slot, date: want.date, today: o.today, open: o.open,
    verdictOf: function (k) { return verdict[k]; },
    nameOf: digest.nameBook(o.messages, o.open.concat(o.closed || [])),
    labels: loops.LABEL
  });
  if (!text) return 'NO ALERT — the ' + slot + ' check found nothing new.';
  /* Which alert this is, for --confirm. On stderr so the alert on stdout stays exactly the message to post. */
  process.stderr.write('alert id: ' + alerts.load(o.dir).pending.id + String.fromCharCode(10));
  return text;
}

/* Diagnostic reports for what the reader just corrected. Queued only; tools/report.js sends.
 * Metadata only — the signal type, not the sentence; the id is salted, not the ledger key. */
function queueReports(dir, cfg, replies, rows) {
  if (!diag.consent(cfg)) return;
  var firstSeen = {};
  rows.forEach(function (r) { firstSeen[L.cell(r[L.COL.key])] = L.cell(r[L.COL.first_seen]); });
  replies.rejected.forEach(function (x) {
    var seen = firstSeen[x.key], age = seen ? Math.round((new Date(x.on) - new Date(seen)) / 864e5) : 0;
    outbox.queue(dir, cfg, { kind: 'item_wrong', signal: x.key.split('|')[0],
      age_days: Math.max(0, Math.min(60, age || 0)), listed: Math.min(99, x.listed) }, [x.key], x.on);
  });
  replies.spot.forEach(function (x) {
    outbox.queue(dir, cfg, { kind: 'item_missed', sampled: Math.min(9, x.sampled),
      missed: Math.min(9, x.missed) }, [x.ref], x.on);
  });
}

/* A crash, as a report: where in our code and the error's class — never its message.
 * A config that cannot be read has no consent in it, so that crash is not reported. */
function queueCrash(argv, e) {
  try {
    var i = argv.indexOf('--config'), configPath = i > -1 && argv[i + 1] ? argv[i + 1] : 'openloops.config.json';
    var cfg = loadConfig(fs, configPath);
    var where = diag.frames(e && e.stack), error = diag.errorClass(e);
    var today = new Date().toISOString().slice(0, 10);
    outbox.queue(path.dirname(path.resolve(configPath)), cfg,
      { kind: 'run_failed', stage: 'runner', error: error, where: where },
      [today, 'runner', error, where[0] || '-'], today);
  } catch (ignore) { /* reporting a failure must never become a second one */ }
}

if (require.main === module) {
  try {
    console.log(main(process.argv.slice(2)));
  } catch (e) {
    queueCrash(process.argv.slice(2), e);
    console.error('open-loops: ' + e.message);
    process.exit(1);
  }
}

module.exports = { queueCrash: queueCrash, main: main, marksFromDm: marksFromDm, inScope: inScope, nameMatches: nameMatches, DIGEST_HEADER: DIGEST_HEADER };
