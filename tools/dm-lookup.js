#!/usr/bin/env node
/* Finds the last real digest in the self-DM, page by page.
 *
 *   node tools/dm-lookup.js --page <file> --number <n> --today YYYY-MM-DD --config <config>
 *   node tools/dm-lookup.js --failed
 *
 * The newest messages in the DM are not always digests: failure notices, alerts and notes are messages too, and
 * a read of the latest five can hold nothing else. So the DM is read newest first, a page at a time, and each page
 * is handed to this tool. <file> holds that page's connector response, copied verbatim:
 *   { "text": "<the response text>", "pagination_info": "<its pagination metadata, verbatim>" }
 * Codex may instead supply `messages` using the runner's structured Slack schema, with source fields unchanged.
 *
 * It prints one of
 *   FOUND ts=… date=… ref=…   the newest digest dated before today: stop, start from it
 *   NEXT                      not here, and more history remains: read the next page, run this again with number+1
 *   NONE                      the whole DM was read and holds no earlier digest (a first run): nothing is wrong
 *   CAPPED                    not found in MAX_PAGES pages, with more history remaining
 *   UNKNOWN                   not found, and the connector gave no pagination evidence, so whether more history exists
 *                             is not known
 *   UNREADABLE                a message on the page could not be parsed, so it may be the digest: the search ends there
 * and, on the ones that end the search, a `dmLookup:` line to copy into the run input. CAPPED, UNKNOWN, UNREADABLE and a failed
 * read (`--failed`) mean the earlier digest could not be located; the digest then says so rather than reading as a first run.
 * No network and no Slack. */
var fs = require('fs');
var { readConversation } = require('../src/slack-json.js');
var { coverage } = require('../src/slack-coverage.js');
var { loadConfig } = require('../src/config.js');
var { DIGEST_HEADER } = require('../slack-run.js');

var MAX_PAGES = 10;

function main(argv) {
  var flag = function (k) { var i = argv.indexOf('--' + k); return i > -1 && argv[i + 1] !== undefined ? argv[i + 1] : null; };
  if (argv.indexOf('--failed') > -1) return 'FAILED — the DM could not be read.\ndmLookup: failed';
  var pageFile = flag('page'), number = Number(flag('number')), today = flag('today');
  if (!pageFile || !Number.isInteger(number) || number < 1 || !/^\d{4}-\d{2}-\d{2}$/.test(today || '')) {
    throw new Error('usage: --page <file> --number <n, from 1> --today YYYY-MM-DD --config <config>');
  }
  var page = JSON.parse(fs.readFileSync(pageFile, 'utf8'));
  if (!page || (typeof page.text !== 'string' && !Array.isArray(page.messages))) {
    throw new Error('the page file needs verbatim "text" or structured "messages"');
  }
  var cfg = loadConfig(fs, flag('config') || 'openloops.config.json');
  var source = { channel: 'DM', pages: [page] };
  var messages = readConversation(source, { channel: 'DM', tzOffset: cfg.tzOffset || 0,
    self: String(cfg.you || 'unknown@localhost').toLowerCase(), selfUid: cfg.selfUid || cfg.selfDm });
  /* A message that could not be parsed may be the digest being looked for, so no answer from this page can be trusted —
   * not NONE, and not an older FOUND either, since the lost one may be newer. */
  if (messages.unparsed) return 'UNREADABLE — a message on this page could not be parsed, and it may be the earlier digest.\ndmLookup: failed';
  var best = null;
  messages.forEach(function (m) {
    var h = String(m.body || '').match(DIGEST_HEADER);
    if (h && h[1] < today && (!best || parseFloat(m.id) > parseFloat(best.ts))) best = { ts: m.id, date: h[1], ref: h[2] || 'none' };
  });
  if (best) return 'FOUND ts=' + best.ts + ' date=' + best.date + ' ref=' + best.ref + '\ndmLookup: found';
  var state = coverage(source, null, 0).state;
  if (state === 'partial') {
    return number >= MAX_PAGES
      ? 'CAPPED — no earlier digest in ' + MAX_PAGES + ' pages, and more history remains.\ndmLookup: capped'
      : 'NEXT — no earlier digest on this page and more history remains: read the next page and run this again with --number ' + (number + 1) + '.';
  }
  if (state === 'complete') return 'NONE — the whole DM history was read and holds no earlier digest.\ndmLookup: searched_none';
  return 'UNKNOWN — no earlier digest here, and the connector gave no pagination evidence, so whether more history exists is not known.\ndmLookup: cannot_page';
}

if (require.main === module) {
  try { console.log(main(process.argv.slice(2))); }
  catch (e) { console.error('dm-lookup: ' + e.message); process.exit(1); }
}

module.exports = { main: main, MAX_PAGES: MAX_PAGES };
