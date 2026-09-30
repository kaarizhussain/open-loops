/* Structured Slack records for hosts whose connector does not use Claude's banners.
 * Preserve message text and timestamps from the source. Profile lookup is separate;
 * an unknown email uses the same stable Slack identity as the text adapter.
 */
var slack = require('./slack.js');

function parseMessages(messages, opts) {
  opts = opts || {};
  if (!Array.isArray(messages)) throw new Error('Slack messages must be an array');
  var users = opts.users || {};
  return messages.map(function (m, i) {
    /* Two shapes Slack really sends that are not a truncated read: a bot posts with a bot_id and no
     * user, and a bot or a file share can carry no text at all. A user's message with no text is still
     * refused — that one can only be a cut-off fetch. */
    var bot = !!m && typeof m === 'object' && (typeof m.bot_id === 'string' || typeof m.subtype === 'string');
    var user = !m ? undefined : typeof m.user === 'string' ? m.user : m.bot_id;
    var text = !m ? undefined : m.text === undefined && bot ? '' : m.text;
    if (!m || typeof m.ts !== 'string' || !/^\d+\.\d+$/.test(m.ts) ||
        !Number.isFinite(Number(m.ts)) || !Number.isFinite(Number(m.ts) * 1000) ||
        typeof text !== 'string' || typeof user !== 'string' ||
        !/^[UWB][A-Z0-9]+$/.test(user)) {
      throw new Error('Invalid Slack message at index ' + i + ': need ts, user and full text');
    }
    if (m.thread_ts != null && (typeof m.thread_ts !== 'string' || !/^\d+\.\d+$/.test(m.thread_ts))) {
      throw new Error('Invalid thread_ts at Slack message ' + m.ts);
    }
    if (opts.threadId && m.thread_ts && m.thread_ts !== opts.threadId) {
      throw new Error('Slack message belongs to a different thread: ' + m.ts);
    }
    // A deleted file arrives as { id, mode: 'tombstone' } with no name; there is nothing to keep of it.
    var files = Array.isArray(m.files) ? m.files.filter(function (f) { return !(f && f.mode === 'tombstone'); }) : m.files;
    if (files != null && (!Array.isArray(files) || files.some(function (f) {
      return !f || typeof f.name !== 'string';
    }))) throw new Error('Slack files must contain source filenames at message ' + m.ts);
    var profile = users[user] || {};
    if (profile.email != null && typeof profile.email !== 'string') {
      throw new Error('Invalid email for Slack user ' + user);
    }
    var body = slack.cleanText(text) || slack.cleanText((files || []).map(function (f) { return f.name; }).join('\n'));
    var thread = opts.threadId || m.thread_ts;
    return {
      id: m.ts,
      threadId: thread || opts.channel || 'slack',
      stream: !thread,
      hasThread: Number(m.reply_count) > 0,
      subject: opts.channel || 'Slack',
      fromName: profile.name || null,
      from: String(profile.email || (user === opts.selfUid && opts.self) || (user + '@slack.local')).toLowerCase(),
      to: [].concat(opts.members || []),
      date: slack.stamp(m.ts, opts.tzOffset),
      body: body,
      attach: !!(files && files.length)
    };
  }).filter(function (m) { return m.body; })
    .sort(function (a, b) { return Number(a.id) - Number(b.id); });
}

function readConversation(conversation, opts) {
  if (Object.prototype.hasOwnProperty.call(conversation, 'pages')) {
    if (!Array.isArray(conversation.pages) || 'text' in conversation || 'messages' in conversation) {
      throw new Error('Supply pages, messages or text for a Slack conversation, not a mixture');
    }
    var byId = {}, suspect = false;
    conversation.pages.forEach(function (page) {
      if (!page || typeof page !== 'object' || 'pages' in page ||
          (!('text' in page) && !('messages' in page))) {
        throw new Error('Each Slack page needs text or messages');
      }
      var got = readConversation(page, opts);
      if (got.suspect) suspect = true;
      got.forEach(function (m) { byId[m.id] = m; });
    });
    var merged = Object.keys(byId).map(function (id) { return byId[id]; })
      .sort(function (a, b) { return Number(a.id) - Number(b.id); });
    Object.defineProperty(merged, "suspect", { value: suspect });
    return merged;
  }
  if (Object.prototype.hasOwnProperty.call(conversation, 'messages')) {
    if (Object.prototype.hasOwnProperty.call(conversation, 'text')) {
      throw new Error('Supply messages or text for a Slack conversation, not both');
    }
    return parseMessages(conversation.messages, opts);
  }
  return slack.parseChannel(conversation.text, opts);
}

module.exports = { parseMessages: parseMessages, readConversation: readConversation };
