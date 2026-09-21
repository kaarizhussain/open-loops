# Open Loops in the Codex app

The same local detector and ledger can run under Claude or Codex. Codex handles
fetching and delivery through its connected tools. No OpenAI API key is required.
This setup targets the desktop Codex app with local Node.js and persistent files.

## Install

From this checkout, run `node tools/install-codex.js`. It installs `open-loops` under
`$CODEX_HOME/skills` (default `~/.codex/skills`) and records the checkout's absolute
path in the installed skill's `local.json`. It will not overwrite an existing skill.
For another supported skill directory, use `--dest /absolute/path/to/open-loops`.
Keep the checkout available; to relocate or update an installed skill, back up the
installed folder and reinstall from the new checkout.

Ask Codex: **Use $open-loops to set up my Slack digest.** Restart the app if needed
for discovery. The skill routes to [the Codex workflow](skills/open-loops/references/codex.md).

Connect the Slack plugin in Codex. The tools must support full channel history,
pagination, thread reads, user profiles, and self-DM read/write; search alone is
insufficient. The skill checks these capabilities before running. Google Calendar
is optional and needs its own connection for meeting coverage. Nothing is scheduled
or posted simply by installing the skill.

## Connector input

The existing Claude `text` format still works. Codex can instead pass structured
Slack records in `messages`, without generating Claude-specific response banners:

```json
{
  "today": "2026-09-21",
  "tzOffset": -240,
  "users": { "U123": { "email": "you@example.com", "name": "Alex" } },
  "conversations": [{
    "channel": "#deals",
    "messages": [{
      "ts": "1790000000.000001",
      "user": "U123",
      "text": "I will send the contract tomorrow."
    }]
  }]
}
```

Each conversation, thread, `dm`, or `dmThread` takes either `text` or `messages`.
The structured fields are documented in the Codex workflow. Map actual connector
fields, preserving their values; the adapter is a documented input contract, not a
claim that every Codex Slack tool returns this exact envelope. Invalid structured
records fail before the ledger is written. Config, scope, ranking, rendering, and
numbered corrections are shared across hosts. `selfUid` separates Slack user identity
from the posting destination `selfDm`; legacy user IDs in `selfDm` remain supported.

Preview with `node slack-run.js input.json --config /path/to/config.json --dry`.
A real run omits `--dry`, so tomorrow's numbered corrections have a saved item order.

## Running alongside Claude

Use separate ledgers and data directories while comparing hosts. A ledger supports
one writer: don't point two daily schedules at it. For a migration, stop the old
schedule before reusing its ledger/config in Codex. Set the same explicit local date
and timezone offset when comparing results.

After a successful manual run, ask Codex to schedule it at your preferred local time.
Keep the computer awake and Codex running. The schedule must use persistent config
and ledger paths, even if a task uses a worktree.

## Validation and limits

`node test/run.js` exercises both input formats, structured thread delivery, DM
corrections, invalid-input handling, and skill installation. Live connector access
and unattended posting still need a manual run in the target Codex account.

Incomplete reads retain missing commitments as not verified, instead of clearing
them. Mark a conversation `complete:true` only after pagination confirms full coverage
of the requested window; use `complete:false` for a known partial read. Without that
confirmation the runner conservatively checks the earliest returned date.
`storeText:false` scrubs stored row text, learned phrases and the rerun snapshot on
the next real run. Raw connector captures and separate backups are not scrubbed.
Codex sees connector
responses; local detection does not mean that all data stays outside the host app.

Official documentation: [skills](https://learn.chatgpt.com/docs/build-skills) and
[scheduled tasks](https://learn.chatgpt.com/docs/automations).
