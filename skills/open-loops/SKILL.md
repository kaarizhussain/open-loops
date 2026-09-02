---
name: open-loops
description: Track commitments made and received in Slack, and send a daily digest of what is about to slip. Use when someone wants to set up Open Loops, run today's digest, schedule it daily, or see how accurate it has been. Also use when they ask what they have promised, what someone owes them, or what has gone quiet.
---

# Open Loops

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

Nowhere. The detector is local code with no network calls in it — the only things that
reach a network are the Slack and calendar connectors they already have, and the digest
you post back to their own DM. Say this plainly if they ask, because someone reading
their employer's Slack is right to ask.

What lands on disk is `ledger.json`, in their working directory. By default it keeps the
text of the message a commitment was found in, so the digest can quote the line back at
them. Setting `"storeText": false` in the config keeps the tracking — keys, dates,
verdicts, accuracy — and drops the words. Offer that to anyone whose workspace holds
material they would rather not have sitting in a file, and tell them the trade: the
digest stops being able to show them what was actually said.

## Setup — first run only

Do not interview them for things the connector already knows.

**1. Find out who they are.**

```
slack_read_user_profile()          → their email and user id
```

The user id is also the channel id of their own DM, which is where the digest goes.

**2. Show them what would be read, and ask what should not be.**

```
slack_list_user_channels(types="public_channel,private_channel")
```

List the channels back and ask which to leave out. Suggest excluding anything social,
random or off-topic — every channel read costs privacy and most of them contain no
commitments. **Do not include `im` in the types.** Direct messages are the most
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
  "channels": { "exclude": ["#social", "#random"] },
  "ledger": "<working dir>/ledger.json"
}
```

Everything else has a working default. Do not write settings they did not ask for —
a config full of defaults is one nobody can tell they have edited.

**5. Run it once** (below) so they see output immediately, then offer to schedule it.

## Running the digest

**Fetch.** Each in-scope channel:

```
slack_read_channel(channel_id=…, limit=100, response_format="detailed")
```

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

And their own DM, which is where corrections come back:

```
slack_read_channel(channel_id=<selfDm>, limit=20, response_format="detailed")
```

**Write the input.** Only what was fetched — settings are already in the config.
Every `text` is the connector's response **verbatim**; do not clean or reformat it, the
adapter parses the raw output.

```json
{
  "today": "<YYYY-MM-DD, local>",
  "tzOffset": <minutes from UTC, negative west>,
  "conversations": [ { "channel": "#name", "members": [], "text": "<verbatim>" } ],
  "threads":       [ { "channel": "#name", "root": "<parent Message TS>", "text": "<verbatim>" } ],
  "events":        <the list_events response>,
  "dm":            { "channel": "<selfDm>", "text": "<verbatim>" }
}
```

**Run:**

```bash
node <checkout>/slack-run.js <input.json> --config <working dir>/openloops.config.json
```

Never pass `--dry` on a real run. A dry run does not record the digest's item order,
and without that record their reply tomorrow cannot be resolved to the right items.

**Post** to their own DM, wrapped in a triple-backtick block — the digest is aligned
monospace and Slack's proportional font destroys it otherwise:

```
slack_send_message(channel_id=<selfDm>, message="```\n<digest verbatim>\n```")
```

Post it even when the list is short or empty. A day with nothing outstanding is useful
information, and a digest that only appears when there is bad news trains the reader to
dread opening it.

**If something fails**, post nothing rather than something half-built, and say what
broke. A digest that silently omits a channel is worse than no digest, because they
cannot tell it apart from a quiet day. The exceptions: if one channel read fails,
continue with the others and note which is missing at the end of the message; if the
calendar fails, run without it and say so.

## Scheduling it

Offer this after the first successful run, not before — nobody wants a daily message
from something they have not seen the output of.

Create a scheduled task running daily at 18:00 local. Evening, so tomorrow starts
already set up rather than starting with triage. The task prompt must be self-contained
— it starts fresh with no memory of this conversation — so write out the working
directory, their user id, their address, and the whole fetch-run-post loop above.

Tell them two things: scheduled tasks only fire while the app is open, and it is worth
running the task manually once so the Slack tool approvals get stored on it. Otherwise
the first automatic run stalls on a permission prompt with nobody watching.

## Changing it, or stopping it

Both are edits to files they own, and it is worth saying so unprompted — a tool that
looks hard to stop is one people are slower to start.

To change what it reads or who it tracks, edit `openloops.config.json` and run again.
Adding a channel to `exclude`, adding a name to `supporting`, moving `lookbackDays` —
all of it takes effect on the next run, and nothing needs rebuilding.

To stop the daily message, delete the scheduled task. The ledger stays where it is, so
picking it up again later resumes rather than restarts. To remove it altogether, delete
the working directory. That is all of it.

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

It has never been validated against anyone's real correspondence. The machinery for
measuring that is built and the numbers start at zero. Say so if they ask how accurate
it is, rather than quoting the demo.

Two of the seven signals need a calendar, and a workspace with one member cannot
exercise the two that need somebody else — nothing inbound ever arrives.
