# Open Loops in the Codex app

The same local detector and ledger can run under Claude or Codex. Codex handles
fetching and delivery through its connected tools. No OpenAI API key is required.
This setup targets the desktop Codex app with local Node.js and persistent files.

## Install

From this checkout, run `node tools/install-codex.js` (`--update` after pulling a new version). It installs `open-loops` under
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

## Your first digest

Codex checks the Slack connection, reads your profile, shows your work channels and
asks which to track. It asks whether you track your own work or support someone
else, unless you already said. Before reading message history, it explains where
the fetched text is processed and saved, then runs your first digest.

The brief goes to your own Slack DM and is echoed in the Codex chat after delivery
is verified. Full details stay in the Slack thread. Codex explains how to correct
items, then offers a daily schedule at your preferred local time. The optional
diagnostic reports question comes last, after your first digest, whether or not
you schedule it. Midday alerts are available when you ask; setup does not offer them.

Google Calendar is optional; connecting it is not required for the first Slack
digest. Local files and conversation history can contain fetched text. Deleting
your data directory removes local files only, not Slack messages, conversation
history or provider-held copies. Turning off sentence storage affects the ledger;
raw run files and backups are not scrubbed.

In this repository owner's deployment, Claude owns the live digest and ledger.
Codex previews only and does not post or create a second schedule for that setup.

## Check status or change the schedule

Ask **Is Open Loops working?** Codex shows the tracked channels, last attempt and
last verified delivery separately. It reports the next run only when the scheduler
provides that information; otherwise it says unknown. New status tracking does not
verify older digests retroactively.

In a Codex-owned setup, real runs record delivery or failure. If Slack is reachable,
a failed run posts a short notice; an uncertain post stays unknown and is not
automatically repeated. Previews record no attempt and send no notice. If the app
was closed and a run never started, Open Loops cannot send a warning at that time.

To change timing, pause or stop, ask Codex. It updates the existing automation only
when requested. Stopping keeps the ledger. In the owner's Claude setup, Codex can
read local status but cannot verify or change the Claude schedule.

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

Each work conversation and thread uses `pages`, with the exact requested `oldest` and
each page's separate `pagination_info`. A page takes either verbatim `text` or structured
`messages`. The self-DM reads remain unpaged and take either `text` or `messages`.
The structured fields are documented in the Codex workflow. Map actual connector
fields without changing their values. Malformed conversations are reported separately;
Codex stops before a real run when a source is incomplete or unreadable. Config,
scope, ranking, rendering, and numbered corrections are shared
across hosts. `selfUid` separates Slack user identity from the posting destination
`selfDm`; legacy user IDs in `selfDm` remain supported.

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

Incomplete reads retain missing commitments from that source as not verified, instead
of clearing them. The runner establishes coverage from the final page's
`pagination_info` and the requested `oldest`; message dates and phrases inside Slack
messages are not coverage evidence. `complete:true` is a fallback only when connector
pagination metadata is unavailable and the final response had no next cursor.
`storeText:false` scrubs stored row text, learned phrases and the rerun snapshot on
the next real run. Raw connector captures and separate backups are not scrubbed.
Codex sees connector
responses; local detection does not mean that all data stays outside the host app.

Official documentation: [skills](https://learn.chatgpt.com/docs/build-skills) and
[scheduled tasks](https://learn.chatgpt.com/docs/automations).
