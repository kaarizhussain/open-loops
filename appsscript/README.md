# Open Loops — the running version

The demo in the repo root is a page. This is the same detector as a scheduled job:
it reads a real mailbox and calendar each evening and emails the digest to whoever
supports that executive.

`src/loops.js` is used unchanged. That was the point of building it as pure functions
over a normalised shape — moving it here needed an adapter, not a rewrite.

## Whose account it runs in

**The executive's.** Gmail delegation is a UI feature, not an API one, so a script in
the assistant's account cannot read a mailbox that has merely been shared with them.
The script lives in the executive's account, runs there on a timer, and emails the
result to the assistant.

The alternative — a service account with domain-wide delegation — reads any mailbox
but needs a Workspace admin and is a much larger conversation. Start with the first one.

## Setup

1. [script.google.com](https://script.google.com) → New project, **in the executive's account**
2. Add three files: `loops.js` (copied from `../src/`), `adapters.js`, `Code.gs`
3. Fill in `CONFIG` at the top of `Code.gs`
4. Run **`preview`** by hand. It logs the digest and emails nobody — read the output
   before anyone else does
5. Run **`installTrigger`** once you're happy with it

## Before you point this at anyone's real mail

Ask first. An assistant reading an executive's inbox is sanctioned; automating the
reading of it is a different thing that nobody has approved yet. At a company holding
regulated data this is not a grey area.

The version most likely to survive that conversation is the one here: read-only,
stores nothing, sends nothing, no third-party processor, no model call. It asks for
less access than several tools that are probably already approved.

## The two weeks that decide it

Run it in shadow for a fortnight before anyone depends on it. It emails you the digest;
you mark each item right or wrong.

**If fewer than eight in ten flagged items are real, fix it or stop.** A list that cries
wolf gets ignored by the third day, and you only get one attempt at someone's trust in it.

## What the adapter has to handle

**Quoted replies** are the whole reason `adapters.js` exists. Every reply carries the
prior thread, so without stripping them the detector finds the same promise once per
message and the list fills with duplicates of one commitment. `test_adapters.js` proves
it: the same two messages yield two commitments unstripped and one stripped.

**Automated senders** manufacture false commitments — notification mail is full of
sentences that parse as promises. `CONFIG.ignoreSenders` drops them; add to it as you
find more.

**Volume.** The demo runs on 25 messages. A real executive gets a hundred a day, so a
false-positive rate that looked fine on the fixture may not be. That's what the fortnight
is for.

## Tests

```bash
node test_adapters.js   # address parsing, quoted-reply stripping, the duplicate bug
node test_render.js     # runs the real Code.gs in a sandbox with Google's globals stubbed
```

`test_render.js` executes `Code.gs` itself rather than a copy, so the digest layout,
section ordering, weekend-deadline note and email subject are all verified. Only the two
API reads can't run outside Apps Script.

## What it will not do

It drafts; it never sends. Nothing is written to the mailbox or the calendar, no reply
goes out on anyone's behalf, and the digest says so at the bottom every time.

An automation that emails on an executive's behalf without review is one bad inference
away from a serious problem, and no amount of accuracy makes that trade worth it.
