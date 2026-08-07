var assert = require('assert');
var { detectLoops, parseDue, LABEL, OWNER } = require('./src/loops.js');
var F = require('./src/fixture.js');

/* date parsing */
assert.strictEqual(parseDue('by Friday Aug 1 at the latest', '2026-07-28T14:12'), '2026-08-01');
assert.strictEqual(parseDue("I'll send it Thursday EOD", '2026-08-03T17:22'), '2026-08-06');
assert.strictEqual(parseDue('questionnaire tomorrow', '2026-07-30T13:00'), '2026-07-31');
assert.strictEqual(parseDue('connect you with Sana this week', '2026-07-30T18:02'), '2026-07-31');
assert.strictEqual(parseDue('no deadline mentioned here', '2026-08-01T10:00'), null);

var r = detectLoops(F.MESSAGES, F.EVENTS, { exec: F.EXEC, today: F.TODAY, contacts: F.RELATIONSHIPS });
var find = function (sub, type) {
  return r.open.filter(function (l) { return l.subject.indexOf(sub) > -1 && (!type || l.type === type); })[0];
};

/* closure detection: delivered promises must NOT appear as open */
assert.ok(!find('Cedarline'), 'Cedarline pricing was delivered — should not be open');
assert.ok(!find('Northwind expansion'), 'security questionnaire was delivered — should not be open');
assert.ok(r.closed.length >= 3, 'expected delivered promises in cleared list, got ' + r.closed.length);

/* the overdue inbound promise */
var mer = find('Meridian', 'owed_to_us');
assert.ok(mer, 'Meridian redlines promise not detected');
assert.strictEqual(mer.due, '2026-08-01');
assert.strictEqual(mer.status, 'overdue');
assert.strictEqual(mer.overdueDays, 5);

/* the promise due today */
var deck = find('board deck', 'owed_by_us');
assert.ok(deck, 'board deck promise not detected');
assert.strictEqual(deck.due, '2026-08-06');
assert.strictEqual(deck.status, 'due_today');

/* agreed but never put on the calendar */
var ref = find('Reference call', 'agreed_unscheduled');
assert.ok(ref, 'reference call should be flagged as agreed-but-unbooked');

/* inbound ask nobody answered — and its stated deadline has passed */
var summit = find('RevOps Summit', 'unanswered_ask');
assert.ok(summit, 'unanswered speaker request not detected');
assert.strictEqual(summit.due, '2026-08-05');
assert.strictEqual(summit.status, 'overdue');

/* a promise with no date of its own inherits the deadline it was answering */
var comp = find('comp plan', 'owed_by_us');
assert.ok(comp, 'comp plan sign-off not detected');
assert.strictEqual(comp.due, '2026-08-08', 'should inherit "by Aug 8" from the request');

/* an outbound proposed date is not a deadline */
var iron = find('Ironwood', 'awaiting_reply');
assert.ok(iron && iron.due === null, 'proposed meeting slot should not become a due date');

/* meeting tomorrow with no agenda, and one today */
assert.ok(find('Vector Freight', 'unprepped_meeting'), 'QBR has no agenda — should flag');
assert.ok(find('Larkspur', 'unprepped_meeting'), 'call today has no agenda — should flag');
assert.ok(!find('Cobalt', 'unprepped_meeting'), 'Cobalt had an agenda');
assert.ok(!find('Weekly revenue staff'), 'internal-only meeting should not flag');
assert.ok(!find('Northwind — expansion kickoff'), 'agenda present and 5 days out');

/* ---- ownership split ---- */
assert.strictEqual(find('Meridian', 'owed_to_us').owner, 'them', 'their unmet promise is a chase');
assert.strictEqual(find('Ironwood', 'awaiting_reply').owner, 'them', 'unanswered question is a chase');
assert.strictEqual(find('board deck', 'owed_by_us').owner, 'exec', 'only the exec writes the revenue section');
assert.strictEqual(find('comp plan', 'owed_by_us').owner, 'exec', 'sign-off cannot be delegated');
assert.strictEqual(find('offsite', 'owed_by_us').owner, 'you', 'booking a venue is the assistant\'s');
assert.strictEqual(find('RevOps Summit', 'unanswered_ask').owner, 'you', 'a bio and talk title can be drafted');
assert.strictEqual(find('Vector Freight', 'unprepped_meeting').owner, 'you', 'agendas are logistics');
assert.strictEqual(find('Reference call', 'agreed_unscheduled').owner, 'you',
  'the exec takes the call, but booking it is the next action');
assert.strictEqual(find('Cobalt', 'no_followup').owner, 'you', 'sending a recap is logistics');
['them', 'you', 'exec'].forEach(function (o) {
  assert.ok(r.open.some(function (l) { return l.owner === o; }), 'no items in pile: ' + o);
  assert.ok(OWNER[o] && OWNER[o].title, 'missing label for pile: ' + o);
});

/* ---- relationship weighting ---- */
var inv = find('Halcyon', 'owed_by_us');
assert.strictEqual(inv.rel.tier, 'investor', 'VC domain should resolve to investor tier');
var deckRel = find('board deck', 'owed_by_us');
assert.strictEqual(deckRel.rel.tier, 'exec', 'exact-address match must beat the domain rule');
assert.strictEqual(find('Solstice', 'owed_to_us').rel.tier, 'partner');
assert.strictEqual(find('offsite', 'owed_by_us').rel.tier, 'internal', 'domain fallback for colleagues');
assert.strictEqual(find('RevOps Summit', 'unanswered_ask').rel, null, 'unknown contacts carry no weight');

/* weighting must actually move the ranking, not just decorate it */
var plain = detectLoops(F.MESSAGES, F.EVENTS, { exec: F.EXEC, today: F.TODAY });
assert.ok(plain.open.every(function (l) { return l.rel === null; }), 'no contacts map means no tiers');
var meridianPlain = plain.open.filter(function (l) { return l.subject.indexOf('Meridian') > -1 && l.type === 'owed_to_us'; })[0];
assert.ok(mer.risk > meridianPlain.risk, 'key-account weighting should raise risk');

/* ranking: overdue and due-today outrank idle chatter */
assert.ok(r.open[0].risk >= r.open[r.open.length - 1].risk);
assert.ok(['overdue', 'due_today'].indexOf(r.open[0].status) > -1, 'top item should be overdue or due today');

console.log('open loops: ' + r.open.length + ' | cleared: ' + r.closed.length + '\n');
['them', 'you', 'exec'].forEach(function (o) {
  var items = r.open.filter(function (l) { return l.owner === o; });
  console.log('== ' + OWNER[o].title.toUpperCase() + ' (' + items.length + ') — ' + OWNER[o].note);
  items.forEach(function (l) {
    console.log('   [' + String(l.risk).padStart(3) + '] ' + LABEL[l.type].padEnd(19) +
      (l.status + '').padEnd(10) + (l.due ? 'due ' + l.due : 'no date').padEnd(15) +
      (l.rel ? l.rel.label : '—'));
    console.log('         ' + l.what);
  });
  console.log('');
});
console.log('\ncleared:');
r.closed.forEach(function (l) { console.log('  ' + l.closedOn + '  ' + l.who + ' — ' + l.what); });
console.log('\nOK');
