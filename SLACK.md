# Open Loops over Slack

The same detector, reading Slack instead of a mailbox, with the digest arriving as a
DM to yourself and corrections typed straight back underneath it.

No server, no Slack app to register, no token to store. Fetching and posting are done
through an already-authorised Slack connector; the deciding is done by `slack-run.js`,
which never touches Slack at all.

## Why it splits that way

`slack-run.js` takes a JSON file and prints text. That is the whole interface, and it
is the point: **a model retrieves and delivers, this decides.** Detection stays
deterministic — the same conversations produce the same list on Tuesday as they did on
Monday, which is not true of anything that asks a model what counts as a commitment.

## The loop

**1. Fetch.** List the conversations, drop the ones out of scope (see below), then read
what is left:

```
slack_list_user_channels(types="public_channel,private_channel")
slack_read_channel(channel_id=…, limit=100)
```

Note the missing `im`. Direct messages are opt-in — add them to `types` only when you
have decided you want them read, rather than because they were in the default.

**Threads are a second fetch.** A channel read announces a root as
`Thread: 2 replies (latest: …)` and does not include the replies, so anything promised
inside one is invisible without going back for it:

```
slack_read_thread(channel_id=…, message_ts=<the root's Message TS>)
```

Also read your own DM — that is where the last digest and any corrections are.

**2. Write what came back:**

```json
{
  "self": "you@example.com",
  "today": "2026-09-01",
  "conversations": [
    { "channel": "#deals", "members": ["lena@vectorfreight.com"], "text": "<connector output>" }
  ],
  "threads": [
    { "channel": "#deals", "root": "1788292991.482509", "text": "<slack_read_thread output>" }
  ],
  "dm": { "channel": "D0…", "text": "<connector output for your self-DM>" },
  "lookbackDays": 21
}
```

The self-DM is read whatever the scope rules say — it is where the digest went and
where corrections come back, not a source of commitments. It is never scanned for
promises; only for replies to a digest.

A thread read repeats its own root message; it is matched by timestamp rather than
appended, so nothing is counted twice. Each thread becomes its own conversation
boundary — the tightest one Slack offers, and the only one as narrow as an email
thread's. If a root's replies are not supplied, the digest says so rather than
quietly leaving them out.

`text` is the connector's response verbatim. The adapter parses it, including the
`Message TS` line — the human date carries a timezone abbreviation and is ignored.

## What it is allowed to read

**Read less than you can.** The connector will happily hand over every channel and
every direct message you have access to, and the default should not be all of it.
Direct messages in particular are the most sensitive thing in a workspace and the
least likely to be about a commitment anyone is tracking.

```json
"scope": {
  "only":    ["deals-*", "#clients"],   // allowlist. Everything else stops existing.
  "exclude": ["#hr", "#leadership"]     // or blocklist. Exclude wins if both name it.
}
```

Names match exactly or by prefix with a trailing star. That is the whole pattern
language, on purpose — a scope rule nobody can read at a glance is a scope rule nobody
checks.

**Apply this when choosing what to fetch, not only here.** The runner is handed
conversations that were already read, so this cannot stop anything reaching it; it is
the second of two checks. It exists for the same reason the Gmail path checks labels
twice — the cost of getting it wrong is someone's private conversation appearing in a
list, and one check is not enough for that.

A thread inherits its channel's scope. Excluding `#hr` and then reading a thread inside
it would be an exclusion that does not exclude.

Conversations left out on purpose are counted and named as such in the digest, because
*"deliberately not read"* and *"failed to read"* are different facts and a reader needs
to tell them apart.

## Who you support

The list is optional and it defaults to empty, which means **you support nobody** —
you are reading your own work. That is the common case here, and it matters because
the digest otherwise sorts your own commitments into a pile headed *needs the
executive*, which is a heading that lies about what is under it.

```json
"principals": []                                   // nobody. Two piles: chase, and yours.
"principals": [{ "label": "Dana" }]                // one. The pile becomes "Needs Dana".
"principals": [                                    // several. Each item says whose.
  { "label": "Dana",   "address": "dana@northstar.io" },
  { "label": "Marcus", "address": "marcus@northstar.io" }
]
```

With several, items are routed by who was actually on the conversation rather than by
guesswork, and the name goes on each line because one heading cannot carry two. That
case only really arises when you read your own account and are copied on several
people's work — which is also the version that needs nobody's permission to set up.

**3. Run it:**

```bash
node slack-run.js input.json --ledger ledger.json
```

Add `--dry` to render without recording the run. Do that first: a real run consumes
the *new* flags, so previewing by hand afterwards would show you a list with nothing
marked new on it.

**4. Post the output** to your own DM, wrapped in a triple-backtick block so the
alignment survives Slack's proportional font.

## Correcting it

Reply in the same DM with the numbers that aren't real:

```
3 7
```

They stop appearing, and the next digest opens with *"Took your last reply — 2 items
marked wrong."* An acknowledgement matters more than it sounds: a correction that
produces no visible response teaches you that corrections don't matter, and then you
stop sending them.

A line beginning with `k` means real-but-already-known:

```
3 7
k 1 4
```

Those stay on the list — they are still outstanding — but stop counting as something
this told you. That second number is the one worth watching. Precision says whether
the list can be trusted; it says nothing about whether it is worth reading.

**Both directions of a self-DM are you**, so a digest is told from a correction by the
only thing that reliably separates them: digests begin with `OPEN LOOPS — for <date>`.
Everything after one, until the next, is read as a reply to it.

Each reply is acted on exactly once. It stays in the DM forever, and re-applying it
against a later, shorter list would mark a different item every run.

## Checking what it never showed you

Every correction so far is about something that appeared: this item is wrong, this one
I already knew. **None of it can say anything about what was missed**, because a miss
produces nothing to reject. So the loop as described above can only ever teach it to be
quieter, never more thorough — and the two worst bugs found in this detector were both
false negatives, invisible to every number it reports.

So each digest also samples the silence:

```
SPOT CHECK — it found nothing in these. Did it miss something?
  a) Sending the signed contract now.      — #new-channel
  b) Let me know your thoughts on the deck when you have a minute.      — #all-open-loops
Reply "miss b d" for any that did contain a commitment, or "miss" on its own
if none did. Saying none is what makes the rest of it evidence.
```

Lettered rather than numbered on purpose: `3` is always a rejection and `c` is always a
miss, so the two can never be confused in a one-line reply. Both can go in the same
reply.

**Answering with no misses still counts.** Without recording the clean ones the
denominator would only grow when something was wrong, and the rate would be
meaningless. A bare `miss` is a real answer.

```
Recall so far: about 84% — 3 misses found in 45 messages spot-checked.
```

Five messages a day for a fortnight is seventy — enough to tell a detector that misses a
third of everything from one that misses almost nothing, and nowhere near enough to put
a confidence interval on it. Read it as an order of magnitude. Set `spotCheck` to change
how many, or `0` to turn it off.

A message the detector *did* find something in is never offered here. It spoke and you
may disagree — that is a rejection, not a miss, and the two must not be conflated. The
sample is also stable for a given day, so an answer given tomorrow still lines up with
what was asked.

## Learning the kind, not just the instance

A verdict suppresses one row, keyed to one sentence in one conversation. That is right
for a one-off and useless for a habit. If *"we'll look at that at some point"* is never
a commitment worth tracking, every fresh instance arrives as a new item and gets
rejected again, forever.

So rejections are read twice — once as a verdict, once as evidence about phrasing. When
a phrase turns up repeatedly in things you rejected and in **nothing you kept**, the
digest proposes it:

```
These turn up in things you rejected and in nothing you kept:
  "at some point" — rejected 4 times
  "when i get a chance" — rejected 3 times
Add any of them to `mute` and they stop being raised at all.
```

The second half of that test is what makes it worth reading. *"I'll send"* is all over
the rejections and all over the real items too, so it means nothing. A phrase that
appears only in the misses is a pattern the detector is actually wrong about.

```json
"mute": ["at some point", "when i get a chance"]
```

Muted items are dropped before the ledger sees them, so they never become items and do
not sit there being counted as false positives forever.

### When it decides for itself

Past four rejections of the same phrase, with none of them kept, it stops asking and
mutes it — and says so:

```
LEARNED — these will not be raised again:
  "at some point" — rejected 4 times, kept none
Wrong about any of them? Add it to `unmute` and it comes straight back.
```

Every run after that carries a standing line — `Currently muting on its own: "at some
point".` — because a rule that shapes the list and is not on the page is exactly what
makes a tool unpredictable. The change itself is fine; hiding it is not.

Learned mutes live in the ledger rather than in config, because config is what you
wrote and this is what the tool concluded, and mixing the two makes it impossible to
tell later which decisions were yours. Each carries the count and date it acted on, so
the reasoning can be checked. Deleting the line undoes it; so does `unmute`, which
always wins.

**Why the bar is four and not two.** Once a phrase is muted, matching items stop
becoming rows — so no further evidence accumulates in either direction, and a mute that
was wrong can never argue its way back. That asymmetry is the whole reason for a high
threshold, a loud announcement, and a one-line undo.

Rejecting a phrase and rejecting an item are also separate decisions. `unmute` stops the
phrase being muted; it does not un-reject rows you already marked wrong, and those stay
held back by their own verdicts.

Below the bar it only proposes. And it says nothing at all until it has a couple of
dozen judged items — frequency over a handful of rows is noise, and a confident wrong
suggestion here mutes real commitments.

Matching is plain case-insensitive substring rather than regex, on purpose: a mute list
is something a person has to be able to check at a glance.

## What it does not do yet

**No calendar.** Two of the seven signals — *agreed but not booked*, and *meeting
unprepped* — compare what was said against what is on the calendar. With Slack alone
they can never fire, and those are the two that platform assistants are least able to
replace. The digest says `0 meetings` and means it.

**An unthreaded channel is one wide boundary.** Threads have their own; plain channel
talk does not, so `lookbackDays` is the only thing bounding closure matching there.
Read three weeks, and a delivery can only be confused with a promise from the same
three weeks.

Set it when fetching too — `slack_read_channel` takes an `oldest` timestamp, and not
reading old messages beats reading and discarding them.

**The window is a trade, not a free knob.** Anything that ages out stops being
detected, and the ledger reads *no longer detected* as *cleared* — so too short a
window quietly reports long-silent promises as done, which is precisely the failure
this exists to prevent. Widen before narrowing, and remember that the oldest items are
the ones most likely to have been forgotten by everyone else too.

**Everything an app posts is signed.** Messages sent through a connector carry a
`*Sent using* @App` footer. Left in the body it would put identical words in every
message, so every message would share subject matter with every other one and
closure matching would start agreeing with everything. Stripped.

**Two formats, neither documented.** A channel read and a thread read do not agree
on shape — one puts the sender on the banner, the other on a separate `From:` line.
Both were copied from live responses. This is the standing cost of parsing a
presentation format, and the reason the adapter has tests built from real output
rather than invented output.

**Nothing is validated.** No number in this repo comes from real chatter. The
conversations in `test_slack_run.js` are invented, the same way the mail fixture is.
The point of the correction loop is to produce the first honest number; it has not
been run against anything real yet.
