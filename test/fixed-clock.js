/* Freezes "now" for a suite, so it does not depend on the day it runs.
 *
 * The alert state prunes check records older than seven days against the real clock
 * (src/alerts.js, save()). A suite that writes records dated 2026-10-01 therefore passed
 * for a week and then failed on every machine, CI included. Production keeps the real
 * clock; a suite that uses fixed dates requires this first.
 *
 * Only the no-argument `new Date()` and `Date.now()` are frozen. A Date built from an
 * argument, Date.UTC and Date.parse behave exactly as before. Set OPENLOOPS_TEST_NOW (an
 * ISO timestamp with a zone) to move the frozen instant; the default is midday UTC on a
 * Monday in the suites' own week, which is the same calendar day in every time zone. */
var RealDate = Date;
var NOW = RealDate.parse(process.env.OPENLOOPS_TEST_NOW || '2026-10-05T12:00:00Z');

function FrozenDate() {
  if (!(this instanceof FrozenDate)) return new RealDate(NOW).toString();
  return arguments.length ? new (Function.prototype.bind.apply(RealDate, [null].concat([].slice.call(arguments))))() : new RealDate(NOW);
}
FrozenDate.prototype = RealDate.prototype;
FrozenDate.now = function () { return NOW; };
FrozenDate.UTC = RealDate.UTC;
FrozenDate.parse = RealDate.parse;

global.Date = FrozenDate;
