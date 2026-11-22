/* Prints the Slack epoch-seconds value for the start of the lookback window: local midnight, <days> days before <today>.
 *
 *   node tools/window.js --today 2026-11-22 --days 21 --tz -300
 *
 * --tz is the config's tzOffset (minutes from UTC, negative west); --days is its lookbackDays. One number on one line, nothing
 * else, so a run does not have to work it out with `node -e`: a run nobody is watching stops at any command it was not allowed
 * to run, and date arithmetic done by hand is where an off-by-a-day `oldest` comes from. */
var a = process.argv.slice(2), g = function (n) { var i = a.indexOf('--' + n); return i > -1 ? a[i + 1] : null; };

function windowStart(today, days, tz) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(today))) throw new Error('--today must be a date like 2026-11-22, got ' + JSON.stringify(today));
  var d = new Date(today + 'T00:00:00Z');
  if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== today) throw new Error('--today is not a real date: ' + today);
  if (!(typeof days === 'number' && isFinite(days) && days >= 0 && days <= 3650)) throw new Error('--days must be a number from 0 to 3650');
  if (!(typeof tz === 'number' && isFinite(tz) && Math.abs(tz) <= 1440)) throw new Error('--tz must be minutes from UTC, like -300');
  return (d.getTime() - days * 86400000 - tz * 60000) / 1000;
}

if (require.main === module) {
  try {
    var days = g('days'), tz = g('tz');
    console.log(String(windowStart(g('today'), days === null || days.trim() === '' ? NaN : Number(days), tz === null || tz.trim() === '' ? NaN : Number(tz))));
  } catch (e) {
    console.error('usage: node tools/window.js --today YYYY-MM-DD --days N --tz MINUTES\n' + e.message);
    process.exit(2);
  }
}

module.exports = { windowStart: windowStart };
