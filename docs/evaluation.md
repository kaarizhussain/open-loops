# Evaluation, and what it does not show

What has been measured, what those measurements are worth, and the hypotheses that
died against them. Summarised in the README; the reasoning is here.

[← README](../README.md)

---



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
