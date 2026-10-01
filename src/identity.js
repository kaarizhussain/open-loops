/* Who said it, kept apart in the ledger.
 *
 * A commitment's key is type|thread|said-date|fnv(sentence). Two people who say the same sentence in one thread on one day share
 * it, so the ledger collapsed them into one row: the second was shown as "not new", and one rejection hid both. The key of a
 * commitment now also says WHOSE it is, whenever that matters — without touching any key that never collided.
 *
 *   person token  sha256(ledger salt | lowercased who), 64 hex. The salt is random, made once and kept in the ledger; the token is a
 *                 one-way identifier, never the address. It is what survives `storeText: false`, which scrubs `who` but must still keep
 *                 two people apart. Pseudonymous, not anonymous: whoever holds the ledger and a list of candidate addresses can test
 *                 guesses, the same exposure as the sentence hash already in every key.
 *   row column    who_id (9th): the token of the person the row belongs to, "~" for a placeholder that a reply created before the
 *                 item had a row (it belongs to whoever fills it), and blank for a row written before identities existed.
 *
 * Which key a person gets, decided per shared base key K and in this order, so a person's key stays the same when others disappear,
 * reorder or age out:
 *   1. a row already keyed K|<their token> is theirs;
 *   2. the row keyed K, if they own it (who_id, or their address in the `who` column of an older row);
 *   3. K|<token> if somebody else owns K;
 *   4. a row keyed K with NO recorded owner is never handed to anybody on the strength of who happens to appear now. With a verdict on
 *      it, it is kept inert under K|ambiguous and reported; without one, a lone person takes it over and a group all get their own;
 *   5. with no row at all: a lone person takes K, and two or more people sharing K each get K|<token>.
 * Two different people never share a key: if two addresses ever produced one token, the second gets K|<token>~2. */
var crypto = require('crypto');

var TOKEN = /^[0-9a-f]{64}$/;
var COL = { key: 0, who: 5, verdict: 7, who_id: 8 };

function norm(w) { return String(w == null ? '' : w).trim().toLowerCase(); }
function cell(c) { return c == null ? '' : String(c).trim(); }
function token(salt, who) { return crypto.createHash('sha256').update(String(salt) + '|' + norm(who)).digest('hex'); }

/* Whose a row is: known (by token, or by the address on an older row), pending (a placeholder a reply made), or unknown. */
function ownerOf(row, salt, tokenFn) {
  var id = cell(row[COL.who_id]);
  if (id === '~') return { state: 'pending' };
  if (TOKEN.test(id)) return { state: 'known', token: id };
  var w = cell(row[COL.who]);
  return w ? { state: 'known', token: (tokenFn || token)(salt, w) } : { state: 'unknown' };
}

/* pairs: every current commitment as { base, who } — open and closed, every key variant the run will look up.
 * Mutates `rows` only to set an older row with no owner aside. Returns
 *   resolve(base, who)  the key for that person's commitment
 *   unowned             [{ base, people }] rows that carried a correction and have no recorded owner, now inert
 *   inert               { <the key they were kept under>: base } */
function apply(rows, pairs, salt, tokenFn) {
  var tok = tokenFn || token;
  var byKey = {}, groups = {}, assigned = {}, unowned = [], inert = {};
  rows.forEach(function (r) { byKey[cell(r[COL.key])] = r; });
  pairs.forEach(function (p) {
    var g = groups[p.base] = groups[p.base] || { people: {}, order: [] };
    var n = norm(p.who);
    if (!g.people[n]) { g.people[n] = { norm: n, tok: tok(salt, n) }; g.order.push(n); }
  });

  var renamed = {};      // rows set aside as K|ambiguous, from the key they had: what restore references have to follow
  Object.keys(groups).forEach(function (base) {
    var g = groups[base], people = g.order.map(function (n) { return g.people[n]; });
    // Different people with one token: never merged. The later one is told apart by a counter.
    var seenTok = {};
    people.sort(function (a, b) { return a.tok < b.tok ? -1 : a.tok > b.tok ? 1 : a.norm < b.norm ? -1 : 1; }).forEach(function (p) {
      var n = seenTok[p.tok] = (seenTok[p.tok] || 0) + 1;
      p.suffix = p.tok + (n > 1 ? '~' + n : '');
    });
    var out = assigned[base] = {};
    var R = byKey[base], baseTaken = false;

    // 1. a person-qualified row already exists for them
    people.forEach(function (p) { if (byKey[base + '|' + p.suffix]) out[p.norm] = base + '|' + p.suffix; });

    // 2 and 4. the base row
    if (R) {
      var o = ownerOf(R, salt, tok), hasVerdict = !!cell(R[COL.verdict]);
      var setAside = function (report) {
        var k = base + '|ambiguous';
        while (byKey[k]) k += '|ambiguous';
        delete byKey[base]; R[COL.key] = k; byKey[k] = R; R = null;
        renamed[base] = k;
        if (report) { unowned.push({ base: base, people: people.length }); inert[k] = base; }
      };
      if (o.state === 'known') {
        var owner = people.filter(function (p) { return p.tok === o.token && !out[p.norm]; })[0];
        if (owner) { out[owner.norm] = base; baseTaken = true; }
      } else if (o.state === 'pending') {
        if (people.length === 1 && !out[people[0].norm]) { out[people[0].norm] = base; baseTaken = true; } else setAside(false);
      } else if (hasVerdict) {
        setAside(true);                                              // a correction with nobody's name on it: not handed to whoever appears
      } else if (people.length === 1 && !out[people[0].norm]) {
        out[people[0].norm] = base; baseTaken = true;                // nothing to misapply: a lone person continues the row
      } else setAside(false);
    }

    // 3 and 5. everyone else
    people.forEach(function (p) {
      if (out[p.norm]) return;
      if (R || baseTaken) out[p.norm] = base + '|' + p.suffix;       // somebody else owns K
      else out[p.norm] = people.length === 1 ? base : base + '|' + p.suffix;
    });
  });

  return {
    renamed: renamed,
    resolve: function (base, who) { var g = assigned[base]; return g && g[norm(who)] ? g[norm(who)] : base; },
    unowned: unowned, inert: inert
  };
}

/* Every (base key, who) the run will look up: the open commitments, and the closed ones under each key variant the merge asks for. A
 * commitment that already closed still counts as a person who matches — leaving it out let a lone open person look like the only owner. */
function pairsFrom(result, baseKey) {
  var pairs = [];
  var add = function (l, type) { if (!l.eventId) pairs.push({ base: baseKey(type ? Object.assign({}, l, { type: type }) : l), who: l.who }); };
  (result.open || []).forEach(function (l) { add(l); });
  (result.closed || []).forEach(function (l) { add(l, l.openType); if (l.byUs) add(l, 'agreed_unscheduled'); });
  return pairs;
}

/* Whether any two different people share a base key: the only time a salt decides a key. */
function hasGroup(pairs) {
  var seen = {};
  return pairs.some(function (p) {
    var g = seen[p.base] = seen[p.base] || {};
    g[norm(p.who)] = 1;
    return Object.keys(g).length > 1;
  });
}

module.exports = { token: token, norm: norm, ownerOf: ownerOf, apply: apply, pairsFrom: pairsFrom, hasGroup: hasGroup, TOKEN: TOKEN };
