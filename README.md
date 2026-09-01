# Open Loops

**Finds the things nobody is chasing — and tells an executive's assistant which is
closest to falling over.**

An executive assistant's real job isn't scheduling — it's being the safety net. Someone
promised something three weeks ago in a thread nobody reopened, and there is no system
anywhere that knows about it. Open Loops reads the mail and the calendar, extracts the
promises, works out which ones closed on their own, and ranks what's left by how close it
is to falling over.

**[▶ Live demo](https://kaarizhussain.github.io/open-loops/)** — a synthetic CRO's Thursday morning. Click any row to see the sentence that triggered it.

<!-- Before sharing, drop a screenshot in as: ![Open Loops](docs/screenshot.png) -->

---

## What it finds

Seven ways a commitment slips, all detected from message text — none of it tagged by hand.

Five of them fire on **nothing having happened**. That is the whole point, and it is
worth putting first: an assistant already knows about the loud problems. What they need
is the thread that has been silent for three weeks, and silence is the one thing a
summariser cannot surface, because there is nothing there to summarise.

| Signal | What fires it | |
|---|---|---|
| **Unanswered** | An inbound request, and no reply from your side | absence |
| **No reply yet** | You asked a question; silence | absence |
| **No follow-up sent** | An external meeting ended and nothing went out after | absence |
| **Meeting unprepped** | External attendees, no agenda attached | absence · two sources |
| **Agreed, not booked** | A call was agreed to, but no calendar hold exists for it | absence · two sources |
| **You promised** | An outbound commitment with no matching delivery since | a sentence exists |
| **They promised** | An inbound commitment and nothing has arrived | a sentence exists |

The last two are the ones anything can do. Point a good summariser at the same mailbox
and it will find sentences that sound like promises too. The five above it cannot: they
are all statements about what is *missing*, and two of them exist only in the gap
between a mailbox and a calendar — the seam no single-product assistant reaches across.

## What comes out

From 25 threads and 5 meetings, grouped by who acts next:

```
OPEN LOOPS — for 2026-08-06

4 are overdue. The oldest by 6 days is Intro to Halcyon Robotics (Investor).

Read 25 messages across 18 threads and 5 meetings.
15 open · 15 new

NEEDS TO GO OUT TODAY
  [LATE] Larkspur Retail — renewal decision — today, no agenda (m.osei@larkspurretail.com)
  Vector Freight — Q3 QBR — tomorrow, no agenda (lena.borg@vectorfreight.com)

NEEDS THE EXECUTIVE (2) — Only they can produce or decide this — protect the time for it.
 1. [today] Yes — I'll send it Thursday EOD.
      CFO · marcus.bell@northstar.io · Q3 board deck — revenue section
 2. [due 2026-08-08] I'll review and get back to you before the deadline.
      People team · hr@northstar.io · Sales comp plan — sign-off needed
      note: stated 2026-08-08 is a weekend — last working day is 2026-08-07

CHASE THEM (4) — Someone else owes this. Your move is the nudge.
 3. [6d late] We will have their comments back to you by Friday Jul 31 at the latest.
      Key account · paul.oyelaran@meridianhealth.com · Meridian MSA — redlines
 ...
```

It opens with the single worst thing rather than with how many messages it read — a
digest that leads with its own statistics is a system reporting on itself. The three
piles are the assistant's actual working split: what only the executive can do, what
someone else owes you, and what you can close out yourself.

The numbers are how you argue with it. Reply with the ones that aren't real and they
stop coming back; that reply is the only record of what this gets wrong.

Each item carries the sentence it came from and the rule that fired. On the demo page,
opening one also gives you a drafted chase note to paste — a list you cannot act on
without rewriting it is a list you stop opening.

## How it works

```
messages + events
   → commitment extraction     cue phrases, per sentence
   → deadline resolution       "Thursday EOD" → 2026-08-06, relative to send date
   → closure matching          did a later message in the thread deliver it?
   → silence + meeting checks  unanswered asks, unbooked calls, missing agendas
   → risk ranking              overdue days, proximity, signal type
```

The detector is deterministic and dependency-free. It takes a normalized shape, so the
source is an adapter concern, not an engine concern:

```js
detectLoops(messages, events, { exec: 'dana@northstar.io', today: '2026-08-06' })
```

Two adapters exist. `appsscript/` reads Gmail and Calendar on a timer inside the
executive's own Google account; [`SLACK.md`](SLACK.md) reads Slack through a connector
and posts the digest back as a DM. Both produce the same shape and share the same
renderer, ledger and correction loop.

**Deterministic is load-bearing, not a preference.** No model decides what counts as a
commitment, so the same mailbox produces the same list tomorrow, nothing is sent to a
third party, and the whole thing can be read by someone deciding whether to approve it.
On the Slack path a model fetches and posts; it never judges.

## Who you support

The list of people you support is optional, and empty means nobody — you are reading
your own work, which is the common case for anyone trying this on themselves.

```js
principals: []                          // nobody. Two piles: chase them, and yours.
principals: [{ label: 'Dana' }]         // one. The pile becomes "Needs Dana".
principals: [{ label: 'Dana',   address: 'dana@northstar.io' },
             { label: 'Marcus', address: 'marcus@northstar.io' }]
```

With several, items route by who was actually on the conversation and the name goes on
each line. Leaving it out entirely keeps the original behaviour: one unnamed executive.

## The parts that were actually hard

**Deadlines live in the wrong message.** *"I'll review and get back to you before the
deadline"* carries no date — the date was in the message being replied to. The engine walks
back up the thread to find it, which is the difference between that item showing as *due
Aug 8* and showing as undated at the bottom of the list.

**A tracker that needs maintaining is worse than no tracker.** Three commitments in the demo
clear themselves, because a later message in the same thread carried an attachment or
delivery wording. Without automatic closure you've built a second to-do list that someone
has to tick off, which is the thing this was supposed to replace.

**False positives are the whole game.** Three real bugs found while building:

- `"let me know"` matched the commitment pattern — it's an *ask*, the exact opposite
- An unrelated internal meeting counted as "booked" because a colleague happened to be on it
- `"Does Thursday work for a call?"` in an outbound message became a deadline, when a
  proposed slot is not a promise

Any one of those makes the morning digest untrustworthy, and an untrusted digest gets
ignored by day three.

**The silent failures are worse, because nothing surfaces to tell you.** A false
positive is annoying and visible. These were neither:

- A bare `"Attached."` closed *every* open promise in a thread, not just the one it
  answered. Things left the list without being done — the exact failure the closure
  check was written to prevent. A delivery that names nothing now closes something only
  when there was one thing it could have meant.
- The delivery vocabulary contained the word `signed`, so *"we'll have the signed order
  form back to you Friday"* read as the form having already been sent, and the promise
  vanished. Tense decides, not vocabulary.
- The Gmail read capped at 300 threads and said nothing when it hit the limit, so a
  half-read mailbox produced a digest indistinguishable from a complete one — and the
  half it drops is the oldest, which is where the overdue items are.

The last one is the pattern: anywhere this can't see something, it now says so.
A list that quietly omits things is worse than one that admits what it missed.

## Quick start

No dependencies, no install, no API keys.

```bash
git clone https://github.com/kaarizhussain/open-loops.git
cd open-loops
node test.js          # the detector, against the demo fixture
node build.js         # rebuilds index.html (downloads fonts on first run)
```

`index.html` is committed, so you can also just open it in a browser.

Everything else is a test, and they are the documentation for how each part is meant to
fail: `test_slack.js` and `test_store.js` for the adapters, `test_ledger.js` for what the
digest remembers between runs, `test_digest.js` for the rendering, `test_slack_run.js`
for the whole Slack path end to end, and `appsscript/` for the Gmail one.

## Pointing it at a real inbox

The engine never touches a mail API. Write an adapter that produces these two shapes and
nothing in `src/loops.js` changes:

```js
message = { id, threadId, subject, from, to: [], date: 'YYYY-MM-DDTHH:MM', body, attach: bool }
event   = { id, title, start: 'YYYY-MM-DDTHH:MM', attendees: [], agenda: bool }
```

Direction is derived from `from` versus the `exec` address, so an adapter never labels
inbound versus outbound. From the Gmail API that's `payload.headers` plus
`payload.parts[].body` for text and `payload.parts[].filename` for `attach`; from Google
Calendar it's `summary`, `start.dateTime`, `attendees[].email`, and whether `description`
is non-empty for `agenda`.

Run it on a schedule and deliver the list wherever the assistant already looks.
[`appsscript/`](appsscript/) does that for Gmail — a daily job inside the executive's own
account, no server and no credential to store. [`SLACK.md`](SLACK.md) does it for Slack,
with the digest arriving as a DM and corrections typed straight back underneath it.

Both keep a ledger, so each digest leads with what changed rather than repeating
yesterday's list, and both take corrections by reply — which is what turns the
false-positive rate into a number instead of an impression.

## What this has not done

**No number in this repo comes from real correspondence.** The detector has been run
against real Slack messages, which found several bugs in the plumbing, but nobody has
yet used it for a fortnight and marked what it got wrong. Until someone has, its
accuracy is unmeasured — and every claim about it here is a claim about the code, not
about the results.

Everything in `src/fixture.js` is invented. Dana Whitfield, Northstar Systems, and every
counterparty, deal, and email in it are fictional, written to exercise each detector
including the cases that should *not* fire. No real inbox was read to build this.

## License

MIT — see [LICENSE](LICENSE). Embedded fonts are SIL OFL 1.1; see
[fonts/NOTICE.md](fonts/NOTICE.md).
