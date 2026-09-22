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
    if (!m || typeof m.ts !== 'string' || !/^\d+\.\d+$/.test(m.ts) ||
        !Number.isFinite(Number(m.ts)) || !Number.isFinite(Number(m.ts) * 1000) ||
        typeof m.text !== 'string' || typeof m.user !== 'string' ||
        !/^[UWB][A-Z0-9]+$/.test(m.user)) {
      throw new Error('Invalid Slack message at index ' + i + ': need ts, user and full text');
    }
    if (m.thread_ts != null && (typeof m.thread_ts !== 'string' || !/^\d+\.\d+$/.test(m.thread_ts))) {
      throw new Error('Invalid thread_ts at Slack message ' + m.ts);
    }
    if (opts.threadId && m.thread_ts && m.thread_ts !== opts.threadId) {
      throw new Error('Slack message belongs to a different thread: ' + m.ts);
    }
    if (m.files != null && (!Array.isArray(m.files) || m.files.some(function (f) {
      return !f || typeof f.name !== 'string';
    }))) throw new Error('Slack files must contain source filenames at message ' + m.ts);
    var profile = users[m.user] || {};
    if (profile.email != null && typeof profile.email !== 'string') {
      throw new Error('Invalid email for Slack user ' + m.user);
    }
    var body = slack.cleanText(m.text) || slack.cleanText((m.files || []).map(function (f) { return f.name; }).join('\n'));
    var thread = opts.threadId || m.thread_ts;
    return {
      id: m.ts,
      threadId: thread || opts.channel || 'slack',
      stream: !thread,
      hasThread: Number(m.reply_count) > 0,
      subject: opts.channel || 'Slack',
      fromName: profile.name || null,
      from: String(profile.email || (m.user === opts.selfUid && opts.self) || (m.user + '@slack.local')).toLowerCase(),
      to: [].concat(opts.members || []),
      date: slack.stamp(m.ts, opts.tzOffset),
      body: body,
      attach: !!(m.files && m.files.length)
    };
  }).filter(function (m) { return m.body; })
    .sort(function (a, b) { return Number(a.id) - Number(b.id); });
}

function readConversation(conversation, opts) {
  if (Object.prototype.hasOwnProperty.call(conversation, 'pages')) {
    if (!Array.isArray(conversation.pages) || 'text' in conversation || 'messages' in conversation) {
      throw new Error('Supply pages, messages or text for a Slack conversation, not a mixture');
    }
    var byId = {};
    conversation.pages.forEach(function (page) {
      if (!page || typeof page !== 'object' || 'pages' in page ||
          (!('text' in page) && !('messages' in page))) {
        throw new Error('Each Slack page needs text or messages');
      }
      readConversation(page, opts).forEach(function (m) { byId[m.id] = m; });
    });
    return Object.keys(byId).map(function (id) { return byId[id]; })
      .sort(function (a, b) { return Number(a.id) - Number(b.id); });
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
