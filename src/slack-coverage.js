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

// A successful empty response is different from nonempty text we could not parse.
function emptyResponse(source) {
  if (Array.isArray(source.pages)) {
    return source.pages.length > 0 && source.pages.every(emptyResponse);
  }
  if (Array.isArray(source.messages)) return source.messages.length === 0;
  return typeof source.text === 'string' && source.text.trim() === '';
}

module.exports = { coverage: coverage, emptyResponse: emptyResponse };
