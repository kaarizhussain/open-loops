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
2. Add four files: `loops.js` (copied from `../src/`), `adapters.js`, `ledger.js`, `Code.gs`
3. Fill in `CONFIG` at the top of `Code.gs`
4. Run **`preview`** by hand. It logs the digest, emails nobody, and records nothing —
   read the output before anyone else does
5. Run **`installTrigger`** once you're happy with it

A spreadsheet named *Open Loops — ledger* is created in the same account on the first
real run, and every digest links to it.

## Before you point this at anyone's real mail

Ask first. An assistant reading an executive's inbox is sanctioned; automating the
reading of it is a different thing that nobody has approved yet. At a company holding
regulated data this is not a grey area.

The version most likely to survive that conversation is the one here: read-only,
stores nothing, sends nothing, no third-party processor, no model call. It asks for
less access than several tools that are probably already approved.

## Why it remembers

The detector is stateless: every run rebuilds the list from the mail. That is right for
the engine and wrong for a daily email. The same fifteen items arriving every morning is
a list nobody reads by Thursday — not because it is inaccurate, but because it is
identical. Repetition kills a digest faster than error does.

So `ledger.js` keeps what the last run found, and every digest opens with what actually
changed:

```
14 open · 1 new · 1 cleared · 2 hidden as wrong
```

Each item carries `NEW` or how many days it has been sitting there, which is its own
kind of overdue. Things the detector stops finding are reported once as cleared — the
only good news in the email, and worth keeping for that reason alone.

## The two weeks that decide it

Run it in shadow for a fortnight before anyone depends on it. Marking an item wrong is
the whole validation loop, so it costs one keystroke: open the ledger, put an `x` in the
verdict column.

That does two things. The item never appears in the digest again — a list that cries
wolf gets ignored by the third day, and you only get one attempt at someone's trust in
it. And it becomes the measurement: **`precisionReport`** prints the wrong-rate broken
out by signal.

```
Tracked 63 items. 9 marked wrong.
86% held up.

By signal:
  You promised: 21/22
  Agreed, not booked: 4/8
```

**If fewer than eight in ten flagged items are real, fix it or stop.** The per-signal
split is what makes that actionable — it is usually one detector dragging the number
down, not the idea.

Unmarked rows count as correct, so the number flatters itself. Explicit right *and*
wrong on every item is the honest measure; nobody sustains it for two weeks, and a test
that gets abandoned yields no number at all. Mark the misses.

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
node test_ledger.js     # new vs seen vs cleared vs marked-wrong, and the precision maths
node test_render.js     # runs the real Code.gs in a sandbox with Google's globals stubbed
```

`test_render.js` executes `Code.gs` itself rather than a copy, against a Sheet that lives
in an array — so the digest layout, section ordering, weekend-deadline note, email subject
and six consecutive runs of the ledger are all verified. Only the two API reads can't run
outside Apps Script.

It checks the two things most likely to go quietly wrong: that a suppressed item does not
reappear inside a meeting brief, and that `preview` reads the ledger without writing to
it — otherwise previewing by hand would consume the "new" flags before the first real
send ever went out.

## What it will not do

It drafts; it never sends. Nothing is written to the mailbox or the calendar, no reply
goes out on anyone's behalf, and the digest says so at the bottom every time. The one
thing it writes anywhere is the ledger, in the same account, holding one line per
detected item.

An automation that emails on an executive's behalf without review is one bad inference
away from a serious problem, and no amount of accuracy makes that trade worth it.
