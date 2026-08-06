# Open Loops

**Finds every commitment in an executive's inbox and calendar, and tells their assistant which ones are about to slip.**

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

| Signal | What fires it |
|---|---|
| **You promised** | An outbound commitment with no matching delivery since |
| **They promised** | An inbound commitment and nothing has arrived |
| **Unanswered** | An inbound request with no reply from your side |
| **No reply yet** | You asked a question; silence |
| **Agreed, not booked** | A call was agreed to, but no calendar hold exists for it |
| **No follow-up sent** | An external meeting ended and nothing went out after |
| **Meeting unprepped** | External attendees, no agenda attached |

## What comes out

From 25 threads and 5 meetings, ranked by risk:

```
open loops: 15 | cleared: 3

 1. [114] You promised       overdue   due 2026-07-31 greg.tan@bridgepointvc.com
     I'll connect you with Sana this week.
 2. [100] Meeting unprepped  due_today due 2026-08-06 m.osei@larkspurretail.com
     No agenda attached
 3. [ 95] They promised      overdue   due 2026-08-01 paul.oyelaran@meridianhealth.com
     We will have their comments back to you by Friday Aug 1 at the latest.
 4. [ 87] They promised      overdue   due 2026-08-03 j.mercer@solsticemedia.com
     We'll send the countersigned copy back Monday.
 5. [ 85] You promised       due_today due 2026-08-06 marcus.bell@northstar.io
     Yes — I'll send it Thursday EOD.
 ...
```

Each item carries the sentence it came from, the rule that fired, and a drafted chase note.

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
mail provider is an adapter concern, not an engine concern:

```js
detectLoops(messages, events, { exec: 'dana@northstar.io', today: '2026-08-06' })
```

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

## Quick start

No dependencies, no install, no API keys.

```bash
git clone https://github.com/kaarizhussain/open-loops.git
cd open-loops
node test.js          # runs the detector and prints the ranked list
node build.js         # rebuilds index.html (downloads fonts on first run)
```

`index.html` is committed, so you can also just open it in a browser.

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

Run it on a schedule and deliver the ranked list wherever the assistant already looks —
email, Slack, or a page like the demo.

## Demo data

Everything in `src/fixture.js` is invented. Dana Whitfield, Northstar Systems, and every
counterparty, deal, and email in it are fictional, written to exercise each detector
including the cases that should *not* fire. No real inbox was read to build this.

## License

MIT — see [LICENSE](LICENSE). Embedded fonts are SIL OFL 1.1; see
[fonts/NOTICE.md](fonts/NOTICE.md).
