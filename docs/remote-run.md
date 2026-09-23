# Remote daily run: scope

Status: **planned, not started.** The current product is frozen until the EA-facing demo
is recorded and shared. This is the next milestone after that, not something the demo
depends on.

## Why

The daily run is a scheduled task on one computer. When that computer is asleep or off,
the digest doesn't go out. The aim: the same digest, from the same deterministic
detector, delivered on schedule with the computer off.

## What does not change

- Detection stays deterministic: no model judgement in `src/`, and the same input with
  the same starting ledger gives the same digest.
- Slack is read only through Claude's connector. No Slack app, no bot token.
- One writer per ledger (AGENTS.md). Only one scheduled task runs the digest for real.
- Fetched Slack text is immutable input. The runner judges coverage from the pagination
  evidence, not from what the model says.

## Already in place, and to keep

- **A same-day re-run starts from the ledger as it was before that day's first run.** Running
  it again the same day, one run after the other, from the same input doesn't apply
  its ledger changes a second time, and replies still match their digest by its `· ref`.
- **The ledger is written to a temporary file and then renamed into place**, so a run
  cut off mid-write cannot leave a half-written ledger.
- **Each run's rendered digest is saved** (`out-YYYY-MM-DD.txt`), so a failed Slack post
  can be sent again without re-running detection.
- **`storeText:false`** keeps keys and verdicts but drops the quoted text.

What these don't cover:
- The same-day re-run guarantee only holds when runs happen one after another. It
  doesn't stop two simultaneous requests, a duplicate Slack post, or not knowing whether
  a remote write finished before a timeout.
- The saved digest can be re-posted, but only from the machine that ran it. Remotely, it
  has to be retrievable by run without re-running detection.

So the remote version needs light request identification and one-writer protection on
the server, not an elaborate new retry system.

## Step 1, after the demo: feasibility spike

No refactor, and the real ledger stays where it is until this is done.

1. Confirm what a remote Claude scheduled task can do: run Node, keep files between
   runs, reach an HTTPS endpoint, and hold a credential somewhere other than its prompt
   or transcript.
2. With the computer off, read one test channel of sanitized data through the Slack
   connector and post a test reply to the self-DM.
3. Compare the two storage options below on credential handling, privacy, retries and
   recovery, using what step 1 actually showed.
4. Write down the result and pick one. Only then plan the build.

## Storage options

| | Protected Worker endpoint + D1 | Private GitHub repository |
|---|---|---|
| Credential | API key held by the remote task | GitHub write credential held by the remote task |
| Privacy | Rows are overwritten in place; a deletion removes the data from the live database, though the provider's backups may keep it for their retention period | Every past ledger stays in Git history unless the history is rewritten |
| Retries | Duplicate-request protection and transactions on the server | A push can conflict or half-finish; recovery is done by hand in Git |
| Resuming a post | The server keeps the finished digest for that run | The saved output file has to be committed or kept somewhere |
| Engineering | Split the engine out of `slack-run.js`; Worker, D1, authentication | Almost none, if a remote task can clone, run Node and push |
| Unknowns | Where the remote task keeps the key | Whether a remote task can clone, run and push reliably |

Leaning: Worker and D1, because the privacy row decides it for Slack-derived data.
Step 1 confirms or overturns that.

## If Worker + D1: the build, as four commits for review

1. Split the reusable engine out of the local runner: input, config and ledger in;
   digest and new ledger out. Local output byte-for-byte unchanged.
2. Worker and D1 ledger: a revocable credential for the one workspace, request
   validation (pages and coverage evidence), one transaction per run, a request ID per
   run, one writer at a time, and the finished digest stored under its run so it can be
   fetched and re-posted.
3. Ledger migration (import, and an export back to local) and the remote task's
   instructions.
4. Operations docs, privacy checks, and an end-to-end test.

Keep raw Slack input and digest text out of run logs. Record the run time, result,
input hash and ledger version only. Consider making `storeText:false` the default for
the hosted ledger.

## Ready when

- Three scheduled runs complete with the computer off.
- The same input and starting ledger give byte-for-byte identical digests locally and
  remotely.
- A reply under a digest changes the next run, and a same-day re-run keeps each
  digest's reference and how replies to it are applied.
- A channel with incomplete coverage affects only its own items.
- A retry or two simultaneous requests cannot apply a change twice.
- A failed Slack post can be resent without re-running detection.
- An invalid request leaves the ledger untouched.
- Privacy tests confirm that text which must not be stored appears in neither storage
  nor logs.
- Switching back to the local schedule loses no ledger state.

## Not in this version

Continuous Slack monitoring. A Slack app or bot token. Multiple workspaces or
self-service onboarding. A dashboard, subscriptions or billing. Agents or model-based
ranking inside the detector.
