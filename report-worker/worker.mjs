/* The report server: a Cloudflare Worker in front of a D1 database.
 *
 * Takes only what src/diagnostics.js allows, byte limit first. Stores the checked report,
 * the day and nothing about the request — no IP, no headers; this file never reads them
 * and never logs (wrangler.jsonc turns Workers Logs off; test_report_worker.js checks
 * both). Deletes everything after 90 days.
 *
 * Alerts go to the owner through a private repo's Actions workflow (alerts/alert.yml),
 * so the issue is written by github-actions[bot] and assigned to the owner. An issue made
 * with the owner's own token notifies nobody — GitHub does not tell you about yourself
 * (tested 2026-09-30). Alerts hold counts and code locations, never an install id.
 */
import D from '../src/diagnostics.js';

const REPO = 'kaarizhussain/open-loops-reports';
const MAX_BYTES = 1024, DAILY_CAP = 50, EXAMPLE_CAP = 5, ALERT_CAP = 10, RETAIN_DAYS = 90;

const day = (t) => new Date(t).toISOString().slice(0, 10);
const reply = (status, body) => new Response(JSON.stringify(body || {}), {
  status, headers: { 'content-type': 'application/json' } });

async function key(s) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return 'k-' + [...new Uint8Array(h)].slice(0, 6).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* With logging off, a failed alert would leave no trace. Its time and GitHub's status go in
 * alert_failures instead — no report content, nothing about any reader. */
function github(env) {
  return async (alert) => {
    let status = 0, detail = '';
    const token = String(env.GITHUB_TOKEN || '').trim();
    // A paste into a hidden prompt can store a stray keystroke instead (2026-09-30). Say so.
    if (!/^(github_pat_|ghp_)[A-Za-z0-9_]+$/.test(token)) detail = 'stored GITHUB_TOKEN is not a GitHub token (' + token.length + ' characters); ';
    try {
      const res = await fetch('https://api.github.com/repos/' + REPO + '/dispatches', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json',
                 'user-agent': 'open-loops-reports', 'x-github-api-version': '2022-11-28' },
      body: JSON.stringify({ event_type: 'open-loops-alert', client_payload: alert })
      });
      status = res.status;
      if (status !== 204) detail += (await res.text()).slice(0, 300);
    } catch (e) { status = 0; detail = String(e && e.name); }
    if (status === 204) return true;
    // GitHub's own error text, about our request. An alert holds no reader data to echo.
    await env.DB.prepare('INSERT INTO alert_failures (at, status, detail) VALUES (?, ?, ?)')
      .bind(new Date().toISOString(), status, detail).run();
    return false;
  };
}

async function alertsLeft(env, today) {
  const row = await env.DB.prepare('SELECT n FROM alerts WHERE day = ?').bind(today).first();
  return ALERT_CAP - (row ? row.n : 0);
}
async function spendAlert(env, today) {
  await env.DB.prepare('INSERT INTO alerts (day, n) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET n = n + 1')
    .bind(today).run();
}

/* Unalerted failures, one alert per signature. A failing send leaves them unalerted for
 * the daily cron; past the day's cap they wait for tomorrow. */
export async function alertFailures(env, now) {
  const today = day(now), send = env.send || github(env);
  const { results } = await env.DB.prepare(
    "SELECT id, sig, body FROM reports WHERE kind = 'run_failed' AND alerted = 0 ORDER BY received LIMIT 200").all();
  const bySig = {};
  for (const r of results) (bySig[r.sig] = bySig[r.sig] || []).push(r);
  for (const sig of Object.keys(bySig)) {
    if (await alertsLeft(env, today) <= 0) return;
    const rows = bySig[sig], reps = rows.map((r) => JSON.parse(r.body));
    const known = await env.DB.prepare('SELECT first_day FROM signatures WHERE sig = ?').bind(sig).first();
    const total = await env.DB.prepare(
      "SELECT COUNT(*) AS n, COUNT(DISTINCT install) AS i FROM reports WHERE kind = 'run_failed' AND sig = ?").bind(sig).first();
    const uniq = (f) => [...new Set(reps.map(f))].sort().join(', ');
    const [stage, error, where] = sig.split('|');
    const ok = await send({
      key: await key('run_failed|' + sig),
      title: 'Run failed · ' + stage + ' · ' + error + (where === '-' ? '' : ' · ' + where),
      labels: 'run-failed,new',
      body: [
        (known ? 'Seen again' : 'New failure') + ' — ' + rows.length + ' report' + (rows.length === 1 ? '' : 's') +
          ' since the last alert; ' + total.n + ' in all from ' + total.i + ' install' + (total.i === 1 ? '' : 's') + '.',
        '', '| | |', '|---|---|',
        '| stage | `' + stage + '` |', '| error | `' + error + '` |',
        '| where | ' + (reps[0].where.length ? reps[0].where.map((w) => '`' + w + '`').join(' ← ') : '(a host step — no code location)') + ' |',
        '| versions | ' + uniq((r) => r.version) + ' |',
        '| hosts | ' + uniq((r) => r.host + ' · node ' + r.node + ' · ' + r.os) + ' |',
        '| first seen | ' + (known ? known.first_day : today) + ' |',
        '| report ids | ' + rows.map((r) => '`' + r.id + '`').join(' ') + ' |',
        '', 'Follow docs/triage.md in the open-loops checkout.'
      ].join('\n')
    });
    if (!ok) return;
    await spendAlert(env, today);
    await env.DB.prepare('INSERT OR IGNORE INTO signatures (sig, first_day) VALUES (?, ?)').bind(sig, today).run();
    for (const r of rows) await env.DB.prepare('UPDATE reports SET alerted = 1 WHERE id = ? AND sig = ?').bind(r.id, sig).run();
  }
}

export async function alertExamples(env, now) {
  const today = day(now), send = env.send || github(env);
  const { results } = await env.DB.prepare('SELECT id, body FROM examples WHERE alerted = 0 LIMIT 20').all();
  for (const r of results) {
    if (await alertsLeft(env, today) <= 0) return;
    const ex = JSON.parse(r.body);
    const ok = await send({
      key: await key('example|' + r.id), title: 'Example shared · ' + ex.signal, labels: 'example,new',
      body: 'A reader shared an example they reviewed. The text is in D1 only:\n\n' +
        '    npx wrangler d1 execute open-loops-reports --remote --command "SELECT body FROM examples WHERE id = \'' + r.id + '\'"\n\n' +
        '| signal | first seen | version |\n|---|---|---|\n| `' + ex.signal + '` | ' + ex.first_seen + ' | ' + ex.version + ' |'
    });
    if (!ok) return;
    await spendAlert(env, today);
    await env.DB.prepare('UPDATE examples SET alerted = 1 WHERE id = ?').bind(r.id).run();
  }
}

/* Mondays: counts by signal for the last seven days. No rate — nothing here counts the
 * items that were not rejected, so a proportion would have no honest denominator. */
export async function weekly(env, now) {
  const today = day(now), since = day(now - 7 * 864e5), sig = 'weekly|' + today, send = env.send || github(env);
  if (await env.DB.prepare('SELECT sig FROM signatures WHERE sig = ?').bind(sig).first()) return;
  const wrong = (await env.DB.prepare(
    "SELECT json_extract(body, '$.signal') AS signal, COUNT(*) AS n, COUNT(DISTINCT install) AS i FROM reports " +
    "WHERE kind = 'item_wrong' AND day > ? AND day <= ? GROUP BY signal ORDER BY n DESC").bind(since, today).all()).results;
  const missed = await env.DB.prepare(
    "SELECT COUNT(*) AS checks, COALESCE(SUM(json_extract(body, '$.missed')), 0) AS missed, COUNT(DISTINCT install) AS i " +
    "FROM reports WHERE kind = 'item_missed' AND day > ? AND day <= ?").bind(since, today).first();
  if (!wrong.length && !missed.checks) return;
  const ok = await send({
    key: await key(sig), title: 'Accuracy · week to ' + today, labels: 'accuracy,new',
    body: [
      'Items marked wrong, ' + since + ' to ' + today + ' (by day received):', '',
      '| signal | marked wrong | installs |', '|---|---|---|',
      ...(wrong.length ? wrong.map((w) => '| `' + w.signal + '` | ' + w.n + ' | ' + w.i + ' |') : ['| — | 0 | 0 |']),
      '', 'Spot checks answered: ' + missed.checks + ', with ' + missed.missed + ' message' +
        (missed.missed === 1 ? '' : 's') + ' marked missed, from ' + missed.i + ' install' + (missed.i === 1 ? '' : 's') + '.'
    ].join('\n')
  });
  if (!ok) return;
  await env.DB.prepare('INSERT OR IGNORE INTO signatures (sig, first_day) VALUES (?, ?)').bind(sig, today).run();
}

export async function receive(req, env, ctx, now) {
  const url = new URL(req.url), today = day(now);
  if (req.method !== 'POST' || (url.pathname !== '/report' && url.pathname !== '/example')) return reply(404);
  const text = await req.text();
  if (text.length > MAX_BYTES) return reply(413);
  let r;
  try { r = JSON.parse(text); } catch (e) { return reply(400); }
  const example = url.pathname === '/example';
  if (!D.exact(r) || (r.kind === 'example') !== example) return reply(400);

  const table = example ? 'examples' : 'reports';
  const used = await env.DB.prepare('SELECT COUNT(*) AS n FROM ' + table + ' WHERE install = ? AND day = ?')
    .bind(r.install, today).first();
  if (used.n >= (example ? EXAMPLE_CAP : DAILY_CAP)) return reply(429);

  const body = JSON.stringify(D.clean(r)), received = new Date(now).toISOString();
  let res;
  if (example) {
    res = await env.DB.prepare('INSERT OR IGNORE INTO examples (install, id, received, day, body) VALUES (?, ?, ?, ?, ?)')
      .bind(r.install, r.id, received, today, body).run();
  } else {
    const sig = r.kind === 'run_failed' ? [r.stage, r.error, r.where[0] || '-'].join('|') : null;
    res = await env.DB.prepare('INSERT OR IGNORE INTO reports (install, id, kind, received, day, body, sig) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(r.install, r.id, r.kind, received, today, body, sig).run();
  }
  if (example) ctx.waitUntil(alertExamples(env, now));
  else if (r.kind === 'run_failed') ctx.waitUntil(alertFailures(env, now));
  return reply(200, { stored: res.meta.changes > 0 });
}

export async function daily(env, now) {
  const cutoff = new Date(now - RETAIN_DAYS * 864e5).toISOString();
  await env.DB.prepare('DELETE FROM reports WHERE received < ?').bind(cutoff).run();
  await env.DB.prepare('DELETE FROM examples WHERE received < ?').bind(cutoff).run();
  await env.DB.prepare('DELETE FROM alert_failures WHERE at < ?').bind(cutoff).run();
  await alertFailures(env, now);
  await alertExamples(env, now);
  if (new Date(now).getUTCDay() === 1) await weekly(env, now);
}

export default {
  fetch: (req, env, ctx) => receive(req, env, ctx, Date.now()),
  scheduled: (event, env, ctx) => ctx.waitUntil(daily(env, event.scheduledTime))
};
