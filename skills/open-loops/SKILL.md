---
name: open-loops
description: Track commitments made and received in Slack, and send a daily digest of what is about to slip. Use when someone wants to set up Open Loops, run today's digest, schedule it daily, see how accurate it has been, or turn diagnostic reports or midday alerts on or off. Also use when they ask what they have promised, what someone owes them, or what has gone quiet.
---

# Open Loops

## Choose the host

In the **Codex app**, read [the Codex workflow](references/codex.md) and follow it
instead of the Claude connector calls and scheduling instructions below. The same
detector and ledger are used by both hosts; connector names and response formats are
not interchangeable. This skill needs local Node.js execution and persistent files.

In **Claude**, follow the workflow below.

Finds the things nobody is chasing — a promise made three weeks ago in a thread nobody
reopened, a call agreed to that never reached a calendar, a question that got no answer
— and posts a ranked list to the user's own Slack DM each day.

**You are the delivery mechanism, not the judge.** A deterministic detector decides
what counts as a commitment. You fetch, run it, and post the result. Never summarise,
re-rank, re-word or add items of your own. If the output looks wrong, post it anyway
and say what looked wrong underneath — the whole value is that the same messages
produce the same list tomorrow, and that stops being true the moment a model starts
improving the output.

## Working directory

Everything lives in one place. Default `~/open-loops-data/`, holding:

- `openloops.config.json` — their setup
- `ledger.json` — what it has seen and what they have said about it
- `checkout/` — the code, from `https://github.com/kaarizhussain/open-loops`

If `checkout/` is missing, clone it. If the directory does not exist, this is a first
run — do **Setup** below before anything else.

This needs `git` and `node` on their machine. Check before setup rather than after, so
a missing one surfaces as a sentence instead of a run that dies halfway through.

## Where their data goes

Not off their machine by the detector: it is local code with no network calls in it. But
the messages are read through the Slack and calendar connectors they already have, and
those responses pass through you, the host assistant, and stay in this conversation's
history. The digest is posted to their own DM. Say this plainly if they ask, because
someone reading their employer's Slack is right to ask — and do not tell them nothing
leaves their machine.

What lands on disk is `ledger.json`, in their working directory, and each run's input
and output files, which hold the fetched message text. By default the ledger keeps the
sentence each commitment was found in, so the digest can say what cleared. Setting
`"storeText": false` keeps the tracking — keys, dates, verdicts, accuracy — and scrubs
message text from the ledger and its rollback snapshot. It does not scrub the input and
output files, backups, the assistant's conversation history, or what is posted to Slack.
The run's input can turn text storage off but never on; only the config decides that.

**Diagnostic reports** are separate and off unless they said yes in Setup. When on,
`tools/report.js` — the one file with a network call — sends the developer a fixed set of
fields: an ID, versions, the date, and a code location or the kind of item corrected.
Never message text, names or paths. Setup step 5 has the exact wording; use it.

With midday alerts on, each check reads the same channels and calendar again, through the same
connectors, so the host assistant sees that text at every check, and an alert is posted to their
own DM. Two small files beside the config, `alerts-baseline.json` (written by the digest) and
`alerts.json` (written by the checks), hold item keys and urgency levels — no message text.

**It costs less than it sounds like.** Every open item in the digest is re-detected from
live messages on each run, so the list still quotes every sentence in full. The single
thing lost is the *cleared since the last run* section, which reads from the ledger and
falls back to `(text not kept)` — it can still say something closed, just not what it
said. Offer this to anyone whose workspace holds material they would rather not have
sitting in a file; for most of them it is close to free.

## Setup — first run only

Do not interview them for things the connector already knows.

**1. Find out who they are.**

```
slack_read_user_profile()          → their email and user id
```

The user id is also the channel id of their own DM, which is where the digest goes.

Write the **user id** (`U…`) into `selfDm`, not a DM channel id (`D…`). Both post
correctly, so a `D…` looks like it works — but the id is also how the run recognises
their own messages when Slack omits an email from the banner, and it does that whenever
the token lacks `users:read.email`. Get it wrong and everything they promised is listed
as something they are waiting on.

**2. Show them what would be read, and ask what should not be.**

```
slack_list_user_channels(types="public_channel,private_channel")
```

List the channels back and ask which ones to **include** — a channel is read only if
they chose it. Suggest the work channels where commitments are made, and leave out
anything social, random or off-topic: every channel read costs privacy and most of them
contain no commitments. **Do not include `im` in the types.** Direct messages are the most
sensitive thing in a workspace and the least likely to hold a tracked commitment; add
them only if the user asks for them by name.

**3. Ask one question, not five: who do they support?**

Nobody is the common answer and the default — they are reading their own work. If they
support one or more executives, take names, and addresses if they have them.

**4. Write `openloops.config.json`:**

```json
{
  "you": "<from step 1>",
  "selfDm": "<their user id>",
  "supporting": [],
  "channels": { "include": ["<the channels they chose>"] },
  "ledger": "<working dir>/ledger.json"
}
```

Everything else has a working default. Do not write settings they did not ask for —
a config full of defaults is one nobody can tell they have edited.

Don't ask about it, but if they mention clients or people who matter most, add them as
`contacts`, keyed by address or whole domain, so those items rank higher and say who
they are:

```json
"contacts": { "vectorfreight.com": { "tier": "key_account", "label": "Vector Freight" } }
```

A tier such as `key_account` or `investor` sets the weight; the label is what the
digest prints. It lives in the config — the run's input can override an entry for a
one-off, but a tier only in the input is gone the next day.

**5. Ask about diagnostic reports.** Once, now, in these words — the default is no, and
nothing is sent until they say yes:

> **Diagnostic reports — off unless you say yes.**
>
> Open Loops can send its developer a small report automatically when a scheduled run
> fails, or when you mark an item wrong or answer a spot check with a miss. Reports go to
> a private database only the developer can read — never posted publicly, no account
> needed.
>
> A report contains only: a random ID created now, the Open Loops version, your Node
> version and operating system, the date, and either where in the code a run failed or
> which kind of item you corrected and how old it was.
>
> It never contains message text, names, email addresses, channel names, Slack IDs, file
> paths, error messages, your config or your ledger.
>
> Cloudflare, which runs the report server, receives your IP address to deliver each
> report. The server is set to keep no request logs, and your IP address is not saved
> with reports; Cloudflare's own handling of network traffic falls under its privacy
> policy. Reports are deleted after 90 days.
>
> Reports are sent without asking each time. Every report sent is listed in
> `reports-sent.log` in your Open Loops folder.
>
> To stop, set `"diagnostics": false` in your config. Reports not yet sent are then
> discarded and never sent. Turning reports back on means answering this question
> again, with a new ID.
>
> If your employer restricts sharing information about workspace tools, check before
> saying yes.
>
> **Send diagnostic reports?** yes / **no**

Only on a yes:

```bash
node <checkout>/tools/report.js --consent --yes --config <working dir>/openloops.config.json
```

(`--consent` without `--yes` prints this question and records nothing.) On a no, write nothing — no `diagnostics` key is the same as off. Never write the
`diagnostics` record by hand; only `--consent` makes one.

**6. Run it once** (below) so they see output immediately, then offer to schedule it.

## Running the digest

**Fetch.** Each in-scope channel:

```
slack_read_channel(channel_id=…, oldest=<window start>, limit=100,
                   response_format="detailed")
```

**Fetch and preserve pagination evidence.** For each in-scope work channel, request
history with `oldest` at the start of the lookback window (local midnight, expressed
as Slack epoch seconds), then follow cursors until no more pages remain. If you omit
`oldest`, fetch the whole history. A quiet first day is not evidence of a partial read.
Fetch every page of each required thread's replies as well.

Use this exact shape for each conversation and thread; threads also require `root`:

```json
{
  "channel": "#name",
  "oldest": "<exact epoch-seconds value sent in the request>",
  "pages": [
    { "text": "<verbatim first page message text>", "pagination_info": "<verbatim pagination metadata>" },
    { "text": "<verbatim next page message text>", "pagination_info": "<verbatim pagination metadata>" }
  ]
}
```

Keep pages in fetch order. Copy message text and the separate `pagination_info`
field unchanged; do not concatenate pages or append metadata to message text. Omit
`oldest` only if no oldest parameter was sent. Never substitute the timestamp of the
oldest returned message for the requested value. Keep the same requested bound while
following cursors. If the connector supplied no pagination metadata, omit that field.

The runner reads coverage from the final page's `pagination_info`, never from phrases
inside Slack messages. No more pages proves coverage only if the requested `oldest`
is at or before the window start, or was omitted. The runner checks this bound too.

Only when pagination metadata is unavailable in the copied response may you supply
`complete:true` on the conversation or thread, and only after the final response
returned no next cursor and no indication that more pages remain. Use `complete:false`
for a known partial or failed fetch; omit it when coverage is unknown. Metadata takes
precedence over this fallback. Do not invent evidence or flags to remove a warning.
Legacy `text` remains accepted as a single page without pagination evidence; without
the fallback flag its coverage is unknown.

Unknown or incomplete coverage preserves unverified commitments from that source only.
Other sources resolve normally, and explicit completion evidence still counts.
Commitments outside the lookback window age out without being reported as completed.

**Self-DM reads are not coverage reads and are never paged.** Keep the short lookup below
(five messages, or fifteen with midday alerts on) and the two correction reads exactly as
described.

Any message containing a line like `Thread: 2 replies (latest: …)` is a thread root
whose replies are **not** in the channel read. Fetch each one — a promise made inside a
thread is invisible otherwise:

```
slack_read_thread(channel_id=…, message_ts=<that message's "Message TS">,
                  response_format="detailed")
```

Their calendar, if they have one connected. Two of the seven signals need it; without
it *meeting unprepped* cannot fire and *agreed but not booked* can never be settled:

```
list_events(startTime=<14 days ago>, endTime=<7 days ahead>, orderBy="startTime")
```

And their own DM, which is where corrections come back — but only what came after the
last digest before today. Everything older is old digests, which the runner never needs,
and retyping them was most of every input file and where the copying errors were. Reads:

```
slack_read_channel(channel_id=<selfDm>, limit=5, response_format="detailed")
```

Use `limit=15` when the config has `alerts` on: alerts posted between digests would
otherwise push the last digest out of a five-message read.

Only to find the digests — messages whose text begins with ` ```OPEN LOOPS — for ` — and
note each one's `Message TS`, the date in its header, and the `D…` id the read printed.
**This read does not go in the input.** The one to start from is the newest digest whose
header date is **before today**. A digest dated today is this run's own earlier output:
this is a re-run, and that digest is read as well, never started from.

```
slack_read_thread(channel_id=<that D… id>, message_ts=<its Message TS>, response_format="detailed")
slack_read_channel(channel_id=<selfDm>, oldest=<its Message TS>, response_format="detailed")
```

On a re-run, also `slack_read_thread` each digest dated today.

The thread reads — each digest, its details, and any replies typed under it — are
`dmThread`: a list, one entry per thread read, each with its digest's `Message TS` as
`root`. The channel read — replies typed straight into the DM since, and on a re-run
today's digest itself — is `dm`; it is often empty, and that is fine. If none of the
messages is a digest dated before today (the first run, or a busy DM), pass the
lookup read as `dm`, add the thread of any digest dated today to `dmThread`, and
otherwise leave `dmThread` out.

Each digest's header ends with a reference (`· ref 7c1e`). The runner uses it to tell
which numbered list a reply answers; copy headers exactly, as with everything else.

**Write the input.** Only what was fetched — settings are already in the config.
Every `text` is the connector's response **verbatim**; do not clean or reformat it, the
adapter parses the raw output.

**Connector responses are immutable.** You may fetch more — a thread you missed, another
page — and run again. You may never edit, reorder, trim, move or "fix" text you already
fetched, not even to repair your own mistake: the detector is only as grounded as its
input is untouched. If the digest says a thread's replies were not read, fetch that
thread and run again. If something in a response looks wrong, fetch it again from Slack;
if it still looks wrong, run it as it is and say what looked wrong under the digest.

**Never repair a copy by hand.** If what you wrote into the input does not match the
response you fetched — a mistyped word, a dropped or added line — do not correct the
text. Fetch that source again and rebuild its field from the fresh response. Then say
under the digest that you did, and which source: an honest account of a slip is worth
more than a clean-looking run. Nothing in the runner can check this for you — it never
sees what Slack actually sent — so this rule is the only guard there is.
A second run on the same day replaces the first in the ledger, so running again costs
nothing.

```json
{
  "today": "<YYYY-MM-DD, local>",
  "tzOffset": <minutes from UTC, negative west>,
  "conversations": [ { "channel": "#name", "members": [], "oldest": "<requested bound>", "pages": [ { "text": "<verbatim>", "pagination_info": "<verbatim>" } ] } ],
  "threads":       [ { "channel": "#name", "root": "<parent Message TS>", "pages": [ { "text": "<verbatim>", "pagination_info": "<verbatim>" } ] } ],
  "events":        <the list_events response>,
  "dmThread":      [ { "root": "<digest Message TS>", "text": "<verbatim thread read under it>" } ],
  "dm":            { "channel": "<selfDm>", "text": "<verbatim read since that digest>" }
}
```

`members` stays `[]` for channels. For a DM, put the other person's address in it
(`["them@co.com"]`): a conversation with exactly one other member is the only place an
item is attributed to someone without evidence in the message itself.

**Run:**

```bash
node <checkout>/slack-run.js <input.json> --config <working dir>/openloops.config.json
```

Never pass `--dry` on a real run. A dry run does not record the digest's item order,
and without that record their reply tomorrow cannot be resolved to the right items.

**Post** in two parts. The output is split by a line reading exactly `-- thread --`: the
brief above it is the message — what to do — and the details below it go in that
message's thread — why. Never post the separator line. Each part goes in its own
triple-backtick block; both are aligned monospace and Slack's proportional font destroys
them otherwise:

```
slack_send_message(channel_id=<selfDm>, message="```\n<brief verbatim>\n```")
slack_send_message(channel_id=<selfDm>, thread_ts=<the ts that call returned>,
                   message="```\n<details verbatim>\n```")
```

**Read the brief back.** Fetch the message you just posted by the timestamp the first
call returned — not simply the newest message, which may be your notes or something
newer. It must open with exactly one code fence, and the first line inside that fence
must equal the first line of the runner's output character for character. The runner's
output is the authority; don't check it against a remembered format. If it differs — a
dropped header, a doubled fence — post the brief and its details again from the saved
runner output, unchanged, and say in the notes that the first post was wrong. Never edit
the posted text to fix it. The header is how the next run finds this digest and matches
replies to it (2026-09-28: a post that lost it was invisible to the next run).

Anything else you post under the digest — something that looked wrong, a source you
fetched again — goes in the same thread, as one message whose first line is exactly
`OPEN LOOPS NOTES — for <YYYY-MM-DD>`. The next run reads that thread for the reader's
corrections, and skips only messages with that header or the details' header; without
it, a note line like "3 items aged out" is read as rejecting item 3.

In the details, the name before a quoted sentence identifies who wrote that Slack
message. It does not identify who owes the commitment, so `You:` is correct under CHASE
THEM when you wrote the source sentence. That is not something to flag.

Post it even when the list is short or empty. A day with nothing outstanding is useful
information, and a digest that only appears when there is bad news trains the reader to
dread opening it.

**If something fails**, post nothing rather than something half-built, and say what
broke. A digest that silently omits a channel is worse than no digest, because they
cannot tell it apart from a quiet day. The exceptions: if one channel read fails,
continue with the others and note which is missing at the end of the message; if the
calendar fails, run without it and say so.

**Last, every run, pass or fail:**

```bash
node <checkout>/tools/report.js --send --config <working dir>/openloops.config.json
```

If the run failed, add `--failed <stage>`, naming where: `pull`, `fetch_slack`,
`fetch_calendar`, `runner`, `post` or `readback`. Pass nothing else — the tool builds
the report itself from fixed fields, and a crash inside the runner has already queued its
own. With diagnostics off it sends nothing and discards anything queued. It never changes
the digest, and its output is not posted anywhere; a report that cannot be sent waits for
the next run.

## Midday check

Only when the "Open Loops checks" task's prompt sends you here — a task of its own, separate from
the daily digest, which never comes here. A check is the digest's fetch followed by a comparison:
has anything become urgent since the last digest? It posts one short alert, or nothing. A quiet
check is silent — no digest, no notes, no summary.

**1. Ask what this run is.** Nothing is fetched to find out:

```bash
node <checkout>/tools/alerts.js --which --config <working dir>/openloops.config.json
```

It prints `CHECK <slot> <date>`, `SKIP — <reason>` or `OFF — <reason>`. On `SKIP` say the reason in one
line and stop; do not fetch. On `OFF` alerts have been turned off: pause this task
(`update_scheduled_task` with `enabled: false`), say so in one line, and stop — it must not keep
starting empty sessions. Only on `CHECK` continue, with that slot and that date — the date is the
machine's local date, and the detector's idea of overdue is relative to it.

**2. Fetch exactly what the digest fetches** — the same channels, threads, calendar and DM
reads, with the same rules, and write the input the same way. Every `text` is the connector's
response verbatim, and the same immutability rules hold.

**3. Run the comparison:**

```bash
node <checkout>/slack-run.js <input.json> --config <working dir>/openloops.config.json --check --slot <slot> --today <date>
```

It reads the ledger and never writes it. It prints one of:

- an alert, which opens with `OPEN LOOPS ALERT — `;
- `NO ALERT — …`, `SKIP — …` or `ALERTS OFF — …`: post nothing, and end with that one line.

**4. Post an alert, verbatim,** as one plain message — no code fence, nothing added:

```
slack_send_message(channel_id=<selfDm>, message=<the runner's output, unchanged>)
```

Read it back by the timestamp the call returned: its first line must equal the first line of
the runner's output character for character. Only then run
`node <checkout>/tools/alerts.js --confirm --config <working dir>/openloops.config.json`, which records
that it was posted so no later check says it again. If the post failed or the read-back differs,
do not confirm: the next check finds the same items and tries again. Never edit the text to fix
it, and never write `alerts.json` by hand.

A check never posts a digest, never touches the ledger, and never asks anything. If something
fails, post nothing and say what broke. The same closing step as a digest applies:
`tools/report.js --send` (with `--failed <stage>` on a failure).

## Scheduling it

Offer this after the first successful run, not before — nobody wants a daily message
from something they have not seen the output of.

Create a scheduled task running daily at 18:00 local. Evening, so tomorrow starts
already set up rather than starting with triage.

**Do not copy this procedure into the task.** A task prompt is frozen when it is written,
so a copied loop keeps running whatever this file said on setup day — the first real
scheduled run did exactly that, fetching an excluded channel with no config at all. The
prompt names where things are and points back here:

```
Run the Open Loops digest and post it to the user's own Slack DM.
Working directory: <working dir>   config: <working dir>/openloops.config.json
1. git -C <working dir>/checkout pull --ff-only   (if it fails, say so and carry on)
2. Read <working dir>/checkout/skills/open-loops/SKILL.md and follow "Running the
   digest" exactly, with that config. Excluded channels are not fetched at all.
Connector responses are immutable: fetch more and run again, never edit fetched text.
```

Tell them two things: scheduled tasks only fire while the app is open, and it is worth
running the task manually once so the Slack tool approvals get stored on it. Otherwise
the first automatic run stalls on a permission prompt with nobody watching.

### Offering midday alerts

Once, and only in a conversation with them: after they have seen a successful manual digest
and the daily schedule exists, and only when the config has no `alerts` entry. Never from a
scheduled run — a scheduled run follows "Running the digest" or "Midday check" and nothing else,
which is why this text lives here. Ask in these words:

> **Midday alerts — off unless you say yes.**
>
> Open Loops can check for changes between daily digests and tell you sooner when something
> needs attention: a new commitment that is overdue, due today, or, for a priority contact,
> due tomorrow, or an existing one that has just become due or overdue.
>
> At 12:00 and 15:00 **your local time** on weekdays, a scheduled check re-reads the
> same Slack channels and calendar as your daily digest and compares them with your last
> digest. Only if something matches, it posts one short alert message to your own Slack DM.
> Each alert lists up to five items. Nothing is posted when nothing matches, so that's at most
> two alerts a day. Items with no due date stay in your evening digest only. A priority
> contact is someone you've marked in your config as a key account, investor or executive.
>
> **Slack may not notify you.** The alert is posted from your own account to your own DM, and
> Slack may not send you a notification for a message you post yourself. Open Loops does not
> send a desktop or phone notification of its own, so an alert can sit unread until you open
> Slack.
>
> **Claude may show a routine notification after every check.** The Claude app may show a
> "Scheduled task completed" notification after each check, including checks that found
> nothing and posted no alert. That notification doesn't say whether there was an alert.
>
> **What this changes.** Saying yes adds a second scheduled task, "Open Loops checks", that
> runs at those times on weekdays. Your daily digest task is not changed. Each check reads the
> same channels as your digest, through your connected Slack and calendar tools, so your
> assistant sees that text again at every check. It uses more of your Claude usage.
>
> **What it needs.** The Claude app open and your computer awake at check times. If it was
> closed or asleep, Claude runs at most one catch-up check when it next opens, for the most
> recent check time it missed, and only if that time was less than two hours ago. Earlier
> missed checks that day are not run, and a check more than two hours late is skipped. Your
> evening digest is a separate task and is not affected.
>
> To stop, tell your assistant, and it turns alerts off and pauses the "Open Loops checks" task
> straight away. If you set alerts to off in your config yourself, that task still starts one
> final, empty session at its next run and pauses itself then; you can also delete it. Your
> daily digest carries on either way. Turning alerts back on means answering this question again.
>
> **Turn on midday alerts?** yes / **no**

On a **yes**:

```bash
node <checkout>/tools/alerts.js --consent --yes --config <working dir>/openloops.config.json
```

(`--consent` without `--yes` prints this question and records nothing.) Then create a **new**
scheduled task named "Open Loops checks", running `0 12,15 * * 1-5` local, with the prompt
below. Do not edit the daily digest task: one cron expression cannot mean "weekdays at 12:00
and 15:00, and every day at 18:00", so a second task is the only way to have no empty
weekend runs and an untouched evening digest. The two tasks have separate schedules but can still
overlap (a catch-up run after the app was closed, a long digest), so they share no file they both
write: the digest task stays the only writer of the ledger and of `alerts-baseline.json`; this
one writes only `alerts.json`. Like the digest prompt, it points back here instead of copying
the procedure:

```
Run the Open Loops midday check for the user's own Slack DM.
Working directory: <working dir>   config: <working dir>/openloops.config.json
1. git -C <working dir>/checkout pull --ff-only   (if it fails, say so and carry on)
2. Run: node <working dir>/checkout/tools/alerts.js --which --config <working dir>/openloops.config.json
   It prints CHECK <slot> <date>, SKIP — <reason>, or OFF — <reason>.
3. Read <working dir>/checkout/skills/open-loops/SKILL.md and follow "Midday check" exactly,
   from step 1, with that output. Excluded channels are not fetched at all.
Connector responses are immutable: fetch more and run again, never edit fetched text.
```

Tell them to run it once by hand so the Slack tool approvals stored on the task cover it; an
unapproved tool stalls an unattended run. On a **no**, run
`node <checkout>/tools/alerts.js --decline --config …` and do not offer again; they can still ask
for alerts later, which is a request rather than an offer.

**Turning alerts off** when they ask: run `node <checkout>/tools/alerts.js --off --config …`,
then pause or delete the "Open Loops checks" task (a paused task starts nothing). If they only
edit the config, the task still starts one final, empty session and pauses itself at its next run
(`OFF`, above). Either way the daily digest
task is never touched.

## Changing it, or stopping it

Both are edits to files they own, and it is worth saying so unprompted — a tool that
looks hard to stop is one people are slower to start.

To change what it reads or who it tracks, edit `openloops.config.json` and run again.
Adding a channel to `exclude`, adding a name to `supporting`, moving `lookbackDays` —
all of it takes effect on the next run, and nothing needs rebuilding.

To stop midday alerts, ask, and the "Open Loops checks" task is paused straight away. Setting
`"alerts": false` in the config yourself works too, but the task then starts one final, empty
session at its next run before it pauses itself (or delete it). The evening digest task carries on
untouched.
Alerts turn on again only by answering the question again.

To stop the daily message, delete the scheduled task. The ledger stays where it is, so
picking it up again later resumes rather than restarts. To remove it altogether, delete
the working directory. That is all of it.

**Turning diagnostic reports on later** — someone set up before reports existed was never
asked, and nothing in the daily run asks them. Only when they ask for it, run
`node <checkout>/tools/report.js --consent --config <working dir>/openloops.config.json`,
show them its output unchanged, and only on a yes run it again with `--yes`.

To stop diagnostic reports, set `"diagnostics": false` in the config. The next run
discards anything not yet sent, and turning them on again means asking the question in
Setup step 5 again, which gives a new ID. `node <checkout>/tools/report.js --show` lists
what is queued and what has been sent.

## How they correct it

This is the part that makes it improve, and it is worth explaining once. They reply in
the same DM:

```
3 7        those two are not real commitments
k 1 4      those are real, but I already knew
miss b     the spot check found something it walked past
```

Rejections stop appearing. `k` keeps the item but stops it counting as something the
tool told them. `miss` answers the sample of messages it found nothing in — and a bare
`miss` meaning "none of them" is a real answer, because without the clean ones the
recall number means nothing.

Past four rejections of the same phrase it mutes it on its own, announces that it has,
and lists it in every digest afterwards. `unmute` in the config overrides that.

**This part needs `storeText`.** Learning the phrase means comparing the sentences of
things they rejected, and `storeText: false` does not keep sentences — so with it on,
rejections still work exactly as before and nothing is ever muted automatically. Say so
if you offered them that setting on privacy grounds, rather than letting them wait for a
feature that will not arrive. `mute` in the config still works by hand.

## When a report needs more detail

Automatic reports carry no text, so they show *that* a kind of item misfires, not *why*.
Only when the reader asks — "send them an example of item 3" — and only with diagnostic
reports on:

```bash
node <checkout>/tools/report.js --example 3 --config <working dir>/openloops.config.json
```

It writes `example-draft.json` in the working directory and prints what would be sent.
Show them that output unchanged, then say, in these words:

> This is text from your Slack. Open Loops attempts to replace email addresses and Slack
> IDs with placeholders, but it may miss some, and names, companies and anything
> confidential in the sentence have **not** been checked. Check the entire sentence before
> sending. You can edit it, send it as it is, or not send it.
>
> **Where it goes.** A sent example is stored in a private database the developer
> controls, not in public, and is deleted from there automatically after 90 days.
>
> **Who may process it.** The developer may investigate it with Claude, an AI assistant,
> using the developer's personal Claude account. If so, the sentence is sent to Anthropic
> as part of that session. How Anthropic uses and keeps it is governed by Anthropic's
> consumer terms and privacy policy and by that account's settings, not by Open Loops. A
> copy may also remain in the session record on the developer's computer.
>
> **What the 90 days covers.** The 90-day deletion applies only to the database. It does
> not delete any copy held by Anthropic or kept on the developer's computer.
>
> It is never posted publicly. Any test added to Open Loops' public code uses made-up
> names and wording, never your sentence.
>
> **send / edit / no**

To edit, change `text` in `example-draft.json` and show them the file again. Only on
**send**:

```bash
node <checkout>/tools/report.js --send-example --config <working dir>/openloops.config.json
```

It sends the draft file exactly as it stands. Never offer this unprompted in a scheduled
run, and never send an example they have not seen.

## Showing how it has been doing

```bash
node <checkout>/slack-run.js --report --config <working dir>/openloops.config.json
```

Three numbers, and they answer different questions. **Precision** says whether the list
can be trusted. **Novelty** says whether it is worth reading — someone with a good
memory could get a flawless digest every morning and gain nothing, and precision alone
would call that a success. **Recall** says how much it walked past, which nothing else
in the loop can see.

If it says recall is unmeasured, that is because they have not answered a spot check
yet, not because it is perfect.

When precision is below 80%, the wrong-rate is what to fix first — read the rejected
items with them and look for the pattern. When precision is high and novelty is low, it
is accurate and useless: it is telling them things they already knew, and the fix is to
look further back or rank differently rather than to add anything.

## What to tell them honestly

Nobody has yet run it against their own correspondence for a fortnight and marked what
it got wrong, so its precision for them is unknown. Say that if they ask how accurate it
is, rather than quoting the demo.

What is known is a rate, from 3,725 real emails in the Enron corpus: it finds something
in about two of every five messages. Most of those are real commitment language rather
than mistakes — people do write "please review this" that often — but it means the list
is long before it is wrong, and the reader's problem on a busy mailbox is volume rather
than error. Worth saying up front to anyone whose inbox is heavy.

Two of the seven signals need a calendar, and a workspace with one member cannot
exercise the two that need somebody else — nothing inbound ever arrives.
