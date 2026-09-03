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

Every line after the first also says what *changed*. The same fifteen items arriving
every morning is a list nobody reads by Thursday — not because it is inaccurate, but
because it is identical. Repetition kills a digest faster than error does, so each item
carries `NEW` or how long it has been sitting there, and anything that dropped off is
reported once as cleared.

Each item carries the sentence it came from and the rule that fired. On the demo page,
opening one also gives you a drafted chase note to paste — a list you cannot act on
without rewriting it is a list you stop opening.

## How it works

```
messages + events
   → commitment extraction     cue phrases, per sentence
   → deadline resolution       "Thursday EOD" → 2026-08-06, relative to send date
   → closure matching          did a later message deliver it, and was it that one?
   → silence + meeting checks  unanswered asks, unbooked calls, missing agendas
   → risk ranking              overdue days, proximity, signal type, relationship
   → the ledger                what is new, what cleared, what you already rejected
```

The detector is deterministic and dependency-free. It takes a normalized shape, so the
source is an adapter concern, not an engine concern:

```js
detectLoops(messages, events, { exec: 'dana@northstar.io', today: '2026-08-06' })
```

One adapter ships: [`SLACK.md`](SLACK.md) reads Slack through a connector and posts the
digest back as a DM. It is deliberately the only one — a second runtime was maintained
for a while over Gmail and Calendar, and keeping two consumers honest cost more than the
second one returned. Writing another is a small job, and *Pointing it at something else*
below says exactly what it has to produce.

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

## How you argue with it

Marking something wrong has to cost about as much as ignoring it, or it does not happen
for fourteen days running — which is exactly how long it takes to learn anything. So
the digest numbers its items and you reply to it. Nothing to open, nothing to log into.

```
3 7            those two are not real commitments
k 1 4          those are real, but I already knew
miss b         the spot check found something it walked past
```

Three replies, three different numbers, and they measure different things:

**Precision** — of what it showed you, how much was real. Whether it can be trusted.

**Novelty** — of what was real, how much you did not already know. Whether it is worth
reading. Someone with a good memory could get a flawless digest every morning and gain
nothing from it, and precision alone would call that a success.

**Recall** — how much it walked straight past. Nothing else in the loop can see this: a
miss produces nothing to reject, so corrections could only ever teach it to be quieter,
never more thorough. Each digest therefore samples its own silence — a handful of
messages it found nothing in — and asks whether it should have. The two worst bugs
found in this detector were both false negatives, invisible to every other number here.

```
Tracked 63 items.
   9 wrong        → 86% held up
  41 already known
  13 genuinely new → 21% told you something
Recall so far: about 84% — 3 misses found in 45 messages spot-checked.
```

Past four rejections of the same phrase, with none of them kept, it stops asking and
mutes it — announcing the change, listing it in every digest afterwards, and undoing it
on one line. It learns the kind, not just the instance, because otherwise the same bad
pattern arrives fresh every morning forever.

**Nothing it learns is hidden.** A detector that rewrites its own rules invisibly is one
nobody can predict, and predictability is most of the reason this is regexes instead of
a model.

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

**Real messages found things reading the code did not.** Pointed at an actual Slack
workspace, four bugs surfaced in the first ten minutes, and none were in the detection
logic:

- messages came back newest-first and were sorted on a minute-truncated date, so within
  a busy minute a promise could land *after* its own delivery and never be closed
- every message sent through an app carries a `*Sent using*` footer, which put identical
  words in all of them — so every message shared subject matter with every other one
- thread replies are not in a channel read at all, so anything promised inside a thread
  was invisible
- reading a thread returns a *different format* from reading a channel, undocumented,
  and the adapter would have silently parsed nothing

Then, on a second batch: two items carried deadlines that appeared nowhere in their own
sentences, inherited from unrelated messages further up the channel. Safe in mail, where
a thread is one subject. Not in chat, where it is a whole room.

## Quick start

No dependencies, no install, no API keys.

```bash
git clone https://github.com/kaarizhussain/open-loops.git
cd open-loops
npm test              # every suite
node build.js         # rebuilds index.html (downloads fonts on first run)
```

`index.html` is committed, so you can also just open it in a browser.

The tests live in `test/` and are the documentation for how each part is meant to fail:
`test.js` for the detector against the demo fixture, `test_slack.js` and `test_store.js`
for the adapters, `test_ledger.js` for what the digest remembers between runs,
`test_digest.js` for the rendering, `test_slack_run.js` for the whole Slack path end to
end.

## Pointing it at something else

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

**Slack is the one to use.** [`SLACK.md`](SLACK.md) has it: the digest arrives as a DM
to yourself and corrections are typed straight back underneath it. Install the skill and
ask Claude to set it up —

```bash
npx skills add kaarizhussain/open-loops
```

— and it reads your address and DM channel off the connector, shows you which channels
it would read so you can strike the ones it should not, writes the config, runs it once,
and offers to schedule it daily.

It keeps a ledger, so each digest leads with what changed rather than repeating
yesterday's list, and it takes corrections by reply.

**Read less than you can.** It takes an exclusion list and an allowlist. An executive's mailbox holds comp discussions and HR matters;
a workspace holds every DM you have. Delegated access is a person with judgement
choosing what to open — this is automated extraction and forwarding, which is a
different thing, and the difference is the entire reason someone might say no.

It also bounds how far back it reads. That window is the only thing keeping closure
matching honest inside an unthreaded channel, and it is a trade rather than a knob:
anything that ages out stops being detected, and the ledger reads *no longer detected*
as *cleared*. Too short a window quietly reports long-silent promises as done, which is
precisely the failure this exists to prevent.

## What this has not done

**Its precision on real correspondence is still unmeasured.** It has now been run over
3,725 real emails from the Enron corpus (`tools/benchmark.js`), which is a great deal
better than a fixture — but that corpus carries no labels, so it can report a rate and
not an accuracy. Nobody has yet used this for a fortnight and marked what it got wrong,
and until somebody has, every claim here is about the code rather than the results.

**What the corpus did establish is a rate, and it is bad: 35.8 items per 100 messages
read.** More than one message in three produces something. That looks close to the true
frequency of commitment language in one-to-one business email, which means the detector
is mostly right and the problem is downstream: the digest prints every open item it is
handed, so a real mailbox produces a list of 178. Selection, not detection.

**What moved the top of that list was metadata, not text.** A quarter of every item — and
a quarter of the top eight of each digest — came out of mail the reader had already
deleted. Respecting that one field did more for the first eight items than four
successive text heuristics: excluding over-broad phrases (worth 1.4%), filtering
distribution lists (68% of items come from mail with exactly one recipient, so almost
nothing), hand-written lists of message genres (leaked three times running), and a
POS-tagged test for whether a promise names an object (cut the rate by a quarter and made
the top eight *worse*, because a sender's signature parses as the object of "I will be
back Thursday"). Each was measured. Every attempt to infer intent from the words lost to
a field that recorded the decision outright.

That last pair is the methodological point worth keeping: **the aggregate rate and the
quality of the first eight items move independently**, and only one of them is read by a
human. Optimising the rate is measuring the wrong thing.

**Is "an open loop" even a well-defined thing?** Worth asking before building anything to
detect one better. Two labellers graded the same 79 top-of-digest items blind, against a
written rubric — a deliverable, a human required, a specific party owing a specific thing.
Raw agreement was 91%, which sounds better than it is: with four items in five being
noise, two labellers who said DROP to everything would agree 62% of the time by luck.
Corrected for that, **Cohen's kappa was 0.76** — substantial. The concept holds up.

The interesting part was the disagreement, which was **entirely one-directional**: seven
items one labeller kept and the other dropped, and *zero* the other way. That is not two
people disagreeing about what a commitment is. It is two people agreeing completely, and
setting the bar in different places — one about 44% more permissive than the other, and
consistently so on institutional mail carrying a real instruction.

Which settles an architectural question. **A benchmark can show a filter is consistent;
it cannot show the threshold is right**, because the threshold is a preference and the
ground truth encodes whichever one the labeller had. So strictness belongs to the reader
as something they turn after a fortnight of digests, not as a constant learned from
whoever labelled the data. That is not built.

One limit on the above: both labellers were language models, which may share priors from
overlapping training rather than converging on something true. Two working assistants
might agree less, or disagree in both directions — and that would mean something quite
different. The measurement stands; its weakness is known.

Read anything from this corpus with one caveat. The bulk-mail headers were stripped when
it was released — `List-Unsubscribe`, `Precedence`, `Auto-Submitted` — so newsletters and
automated bounces can only be identified from their text here, while a live adapter
settles them with one header check. It makes a solved problem look like a hard one, and
noise measured against it is an overstatement.

**Three of the seven signals have still never fired on anything real.** *Meeting
unprepped* and the calendar half of *Agreed, not booked* need a calendar the Slack path
has not had; *No follow-up sent* needs a recipient list that chat does not carry, and now
says so rather than firing blind.

Everything in `src/fixture.js` is invented. Dana Whitfield, Northstar Systems, and every
counterparty, deal, and email in it are fictional, written to exercise each detector
including the cases that should *not* fire. No real inbox was read to build this.

## License

MIT — see [LICENSE](LICENSE). Embedded fonts are SIL OFL 1.1; see
[fonts/NOTICE.md](fonts/NOTICE.md).
