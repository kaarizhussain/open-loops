# What was actually hard

Every bug below was found by running the detector against real messages, never by
reading the code. Four separate times. They are kept because the failures say more
about what this problem is than the working parts do.

[← README](../README.md)

---



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
