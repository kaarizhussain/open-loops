/* Digest findings from the whole-product review, rendered with handcrafted results so each case is exactly the shape that failed:
 *   - two people with one first name were both printed as "Chase sam"
 *   - a trimmed pile pointed at `listCap`, which is not a setting, and two sections were cut with no count at all
 *   - an empty list with items that could not be verified still said "Nothing outstanding. Genuinely"
 */
var assert = require('assert');
var loops = require('../src/loops.js');
global.OWNER = loops.OWNER;
global.LABEL = loops.LABEL;
global.loopKey = loops.loopKey;
var { render, SPLIT } = require('../src/digest.js');

var parts = function (t) { var i = t.indexOf(SPLIT); return { brief: t.slice(0, i), details: t.slice(i + SPLIT.length) }; };
var base = function (over) {
  return Object.assign({ today: '2026-09-04', source: 'slack', messages: [{}], events: [], result: { open: [], closed: [], dark: 0 }, briefs: [],
    ledger: { shown: [], gone: [] }, marked: 0, read: { threads: 2, unread: [], shortRead: [], skipped: 0, windowDays: 21 } }, over);
};
var item = function (n, who, what) {
  return { type: 'owed_to_us', owner: 'them', status: 'overdue', overdueDays: 10 - n, what: what || 'send the pricing ' + n, subject: '#ops', who: who || '', n: n };
};

/* ------------------------------ two people with one first name are told apart ------------------------------ */
var sams = [{ from: 'sam@northstar.example', fromName: 'Sam Okafor' }, { from: 'sam@acme.example', fromName: 'Sam Lee' }];
var two = render(base({ messages: sams, result: { open: [item(1, 'sam@northstar.example', 'send the pricing'), item(2, 'sam@acme.example', 'send the contract')], closed: [], dark: 0 } }));
var both = two.split('\n').filter(function (l) { return /send the (pricing|contract)/.test(l); }).join('\n');
assert.ok(/sam@northstar\.example/.test(parts(two).brief) && /sam@acme\.example/.test(parts(two).brief), 'the brief names each by address:\n' + parts(two).brief);
assert.ok(!/\bChase sam\b(?!@)/.test(two) && !/\bsam: "/.test(two), 'never the bare "sam" for both:\n' + both);
// The second tier of the brief (ALSO OPEN) and the details tell them apart too.
var tiered = render(base({ messages: sams, result: { open: [item(1), item(2), item(3), item(4, 'sam@northstar.example', 'send the pricing'), item(5, 'sam@acme.example', 'send the contract')], closed: [], dark: 0 } }));
var alsoOpen = parts(tiered).brief.split('\n').filter(function (l) { return /send the (pricing|contract)"/.test(l); }).join('\n');
assert.ok(/sam@northstar\.example: "send the pricing"/.test(alsoOpen) && /sam@acme\.example: "send the contract"/.test(alsoOpen), 'ALSO OPEN names each Sam by address:\n' + alsoOpen);
// One Sam on the list is still just Sam.
var one = render(base({ messages: [sams[0]], result: { open: [item(1, 'sam@northstar.example', 'send the pricing')], closed: [], dark: 0 } }));
assert.ok(/Chase Sam\b/.test(parts(one).brief) && !/@northstar/.test(parts(one).brief.split('\n').filter(function (l) { return /Chase/.test(l); }).join('')), 'and with no collision the first name is enough:\n' + parts(one).brief);
// An address with no first name at all keeps its local part.
var bare = render(base({ messages: [{ from: 'j.mercer@acme.example' }], result: { open: [item(1, 'j.mercer@acme.example', 'send the pricing')], closed: [], dark: 0 } }));
assert.ok(/Chase j\.mercer\b/.test(bare), 'no collision, no first name: the local part, as before');

/* ------------------------------ a trimmed pile says what it is, and promises nothing ------------------------------ */
var five = [1, 2, 3, 4, 5].map(function (n) { return item(n, '', 'send the pricing ' + n); });
var trimmed = parts(render(base({ listCap: 2, result: { open: five, closed: [], dark: 0 } }))).details;
assert.ok(/… and 3 more in this pile, ranked below these\. They remain tracked but are not shown in this digest\./.test(trimmed), trimmed);
assert.ok(!/listCap|Raise/.test(trimmed), 'and it no longer points at a setting that does not exist');
assert.ok(!/eventually|will appear|come back|return/i.test(trimmed.split('\n').filter(function (l) { return /more in this pile/.test(l); }).join(' ')), 'and promises nothing about when they show');

/* ------------------------------ no silent cuts ------------------------------ */
var unknown = []; for (var i = 0; i < 15; i++) unknown.push({ what: 'unverified item ' + i, who: 'Dana' });
var ud = parts(render(base({ ledger: { shown: [], gone: [], unknown: unknown } }))).details;
assert.ok(/NOT VERIFIED \(15\)/.test(ud) && /\n  … and 5 more\.\n/.test(ud), 'ten shown and the other five counted:\n' + ud);
assert.strictEqual((ud.match(/unverified item \d+/g) || []).length, 10);
var udCap = parts(render(base({ listCap: 12, ledger: { shown: [], gone: [], unknown: unknown } }))).details;
assert.ok(/\n  … and 3 more\.\n/.test(udCap), 'with a cap of 12, three are held and counted');
var udAll = parts(render(base({ listCap: 12, ledger: { shown: [], gone: [], unknown: unknown.slice(0, 12) } }))).details;
assert.ok(!/… and \d+ more\./.test(udAll), 'nothing is said when nothing is held');
var closed = []; for (var c = 0; c < 13; c++) closed.push({ type: 'owed_to_us', openType: 'owed_to_us', owner: 'them', what: 'closed item ' + c, subject: '#ops', who: 'Dana', closedBy: 'done', closedOn: '2026-09-03' });
var cd = parts(render(base({ result: { open: [], closed: closed, dark: 0 } }))).details;
assert.ok(/CLOSED ITSELF \(13\)/.test(cd) && /\n    … and 3 more\.\n/.test(cd), 'ten closed shown and three counted:\n' + cd);
assert.strictEqual((cd.match(/closed item \d+/g) || []).length, 10);
var cd2 = parts(render(base({ result: { open: [], closed: closed.slice(0, 10), dark: 0 } }))).details;
assert.ok(!/… and \d+ more\./.test(cd2), 'ten of ten: nothing held, nothing said');

/* ------------------------------ an empty list with unverified items is not clear ------------------------------ */
var one1 = parts(render(base({ ledger: { shown: [], gone: [], unknown: [unknown[0]] } }))).brief;
assert.ok(one1.indexOf('Nothing found in what was read — but 1 item could not be verified. Do not treat this as clear.') > -1, one1);
assert.ok(!/Nothing outstanding/.test(one1));
var three = parts(render(base({ ledger: { shown: [], gone: [], unknown: unknown.slice(0, 3) } }))).brief;
assert.ok(three.indexOf('but 3 items could not be verified.') > -1, three);
var clean = parts(render(base({}))).brief;
assert.ok(/Nothing outstanding\. Genuinely — the list is empty\./.test(clean), 'nothing unverified, nothing incomplete: the approved sentence');
var both2 = parts(render(base({ ledger: { shown: [], gone: [], unknown: [unknown[0]] }, read: { threads: 2, unread: [], shortRead: [{ channel: '#ops', reason: 'more pages remain' }], skipped: 0, windowDays: 21 } }))).brief;
assert.ok(/the read was INCOMPLETE/.test(both2) && !/could not be verified\. Do not/.test(both2), 'an incomplete read says so, once: ' + both2);
// With an item on the list, the headline is not used at all.
var listed = parts(render(base({ ledger: { shown: [], gone: [], unknown: [unknown[0]] }, result: { open: [item(1)], closed: [], dark: 0 } }))).brief;
assert.ok(!/Nothing found in what was read|Nothing outstanding/.test(listed));

console.log('digest batch: OK');
