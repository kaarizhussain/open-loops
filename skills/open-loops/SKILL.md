---
name: open-loops
description: Track commitments made and received in Slack, and send a daily digest of what is about to slip. Use when someone wants to set up Open Loops, run today's digest, schedule it daily, or see how accurate it has been. Also use when they ask what they have promised, what someone owes them, or what has gone quiet.
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

Nowhere. The detector is local code with no network calls in it — the only things that
reach a network are the Slack and calendar connectors they already have, and the digest
you post back to their own DM. Say this plainly if they ask, because someone reading
their employer's Slack is right to ask.

What lands on disk is `ledger.json`, in their working directory. By default it keeps the
sentence each commitment was found in, so the digest can say what cleared. Setting
`"storeText": false` keeps the tracking — keys, dates, verdicts, accuracy — and writes no
message text at all.

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

Don't ask about it, but if they mention clients or people who matter most, add them as
`contacts`, keyed by address or whole domain, so those items rank higher and say who
they are:

```json
"contacts": { "vectorfreight.com": { "tier": "key_account", "label": "Vector Freight" } }
```

A tier such as `key_account` or `investor` sets the weight; the label is what the
digest prints. It lives in the config — the run's input can override an entry for a
one-off, but a tier only in the input is gone the next day.

**5. Run it once** (below) so they see output immediately, then offer to schedule it.

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

**Self-DM reads are not coverage reads and are never paged.** Keep the five-message
lookup and the two correction reads below exactly as described.

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
today's digest itself — is `dm`; it is often empty, and that is fine. If none of the five
messages is a digest dated before today (the first run, or a busy DM), pass the
five-message read as `dm`, add the thread of any digest dated today to `dmThread`, and
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

Anything else you post under the digest — something that looked wrong, a source you
fetched again — goes in the same thread, as one message whose first line is exactly
`OPEN LOOPS NOTES — for <YYYY-MM-DD>`. The next run reads that thread for the reader's
corrections, and skips only messages with that header or the details' header; without
it, a note line like "3 items aged out" is read as rejecting item 3.

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

**This part needs `storeText`.** Learning the phrase means comparing the sentences of
things they rejected, and `storeText: false` does not keep sentences — so with it on,
rejections still work exactly as before and nothing is ever muted automatically. Say so
if you offered them that setting on privacy grounds, rather than letting them wait for a
feature that will not arrive. `mute` in the config still works by hand.

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
