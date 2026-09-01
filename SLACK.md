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

**1. Fetch.** List the conversations worth reading, then read each one:

```
slack_list_user_channels(types="public_channel,private_channel,im")
slack_read_channel(channel_id=…, limit=100)
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
  "dm": { "channel": "D0…", "text": "<connector output for your self-DM>" }
}
```

`text` is the connector's response verbatim. The adapter parses it, including the
`Message TS` line — the human date carries a timezone abbreviation and is ignored.

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

## What it does not do yet

**No calendar.** Two of the seven signals — *agreed but not booked*, and *meeting
unprepped* — compare what was said against what is on the calendar. With Slack alone
they can never fire, and those are the two that platform assistants are least able to
replace. The digest says `0 meetings` and means it.

**No threads.** Slack thread markers are matched loosely and have never been seen in
practice, so every conversation is treated as one unit. That is wider than an email
thread, and the read window is what keeps it honest: read three weeks and a delivery
can only be confused with a promise from the same three weeks.

**Nothing is validated.** No number in this repo comes from real chatter. The
conversations in `test_slack_run.js` are invented, the same way the mail fixture is.
The point of the correction loop is to produce the first honest number; it has not
been run against anything real yet.
