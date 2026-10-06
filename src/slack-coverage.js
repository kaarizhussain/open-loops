/* Coverage is connector metadata, never a phrase in a Slack message. */
function coverage(source, windowStart, tzOffset) {
  var pages = source.pages;
  var last = Array.isArray(pages) && pages.length ? pages[pages.length - 1] : null;
  var state = 'unknown', reason = 'pagination evidence is missing';
  if (last && Object.prototype.hasOwnProperty.call(last, 'pagination_info')) {
    var info = typeof last.pagination_info === 'string' ? last.pagination_info.trim() : '';
    var cursorMatch = info.match(/["']?next_cursor["']?\s*[:=]\s*(?:["'`]([^"'`]*)["'`]|([^\s,}]+))/i);
    var cursor = cursorMatch && (cursorMatch[1] != null ? cursorMatch[1] : cursorMatch[2]);
    var hasMore = /\bThere are more messages\b/i.test(info) ||
      /["']?has_more["']?\s*[:=]\s*true\b/i.test(info) ||
      !!(cursor && !/^null$/i.test(cursor));
    var exhausted = /\bThere are no more messages\b/i.test(info) ||
      /["']?has_more["']?\s*[:=]\s*false\b/i.test(info) ||
      !!(cursorMatch && (!cursor || /^null$/i.test(cursor)));
    if (hasMore) {
      state = 'partial'; reason = 'more pages remain';
    } else if (exhausted) {
      state = 'complete'; reason = '';
    } else {
      reason = 'pagination evidence is not recognized';
    }
  } else if (source.complete === true) {
    state = 'complete'; reason = '';
  } else if (source.complete === false) {
    state = 'partial'; reason = 'the fetch was marked partial or failed';
  }

  // oldest is Slack epoch seconds, copied from the request, not the oldest message.
  // No lookback means all history; only an absent bound or epoch zero covers it.
  if (source.oldest != null) {
    var valid = typeof source.oldest === 'string' && /^\d+(?:\.\d+)?$/.test(source.oldest);
    var bound = valid ? Number(source.oldest) : NaN;
    var start = windowStart ? Date.parse(windowStart + 'T00:00:00Z') / 1000 - (tzOffset || 0) * 60 : 0;
    if (!Number.isFinite(bound) || bound > start) {
      state = 'partial'; reason = 'requested oldest does not cover the window start';
    }
  }
  return { state: state, reason: reason };
}

/* A read with nothing in it comes back as the channel's header and no messages: "Channel: #name (C0…)" and a blank line, with the connector's "There are no more messages" as its
 * pagination note (seen on a real run for a channel whose messages were all older than the window, and earlier for the self-DM). Only a line that is exactly such a header is the
 * connector's: a header with no id, extra words, or anything else left over is text with no message in it, and is still reported. Nothing is edited; this only decides what
 * counts as empty. Whether the read was COMPLETE is the pagination note's to say (coverage), not the header's. */
var HEADER_LINE = /^[ \t]*Channel: [^\r\n()]*\([A-Z][A-Z0-9]{4,}\)[ \t]*$/gm;
function withoutHeader(text) { return String(text).replace(HEADER_LINE, ''); }

// A successful empty response is different from nonempty text we could not parse.
function emptyResponse(source) {
  if (Array.isArray(source.pages)) {
    return source.pages.length > 0 && source.pages.every(emptyResponse);
  }
  if (Array.isArray(source.messages)) return source.messages.length === 0;
  return typeof source.text === 'string' && withoutHeader(source.text).trim() === '';
}

module.exports = { coverage: coverage, emptyResponse: emptyResponse, withoutHeader: withoutHeader };
