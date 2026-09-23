# Working on Open Loops

Rules for any coding agent (Claude, Codex, or other) working in this repo. `CLAUDE.md`
imports this file; keep the rules here, in one place.

## Pushing is deploying

- Never `git push` without a fresh, explicit "push" from the owner, every time. An
  earlier approval, or advice like "I'd push it", is not one.
- The daily scheduled run pulls `main` from GitHub before it runs, so whatever is pushed
  goes live at the next 18:00 run.
- Commit locally when work is done and tested; leave the push to the owner.

## One writer per ledger

- Only the scheduled Claude task (`open-loops-daily`) runs the digest for real and posts
  it to the self-DM. Every other agent — Codex included — runs with `--dry` and never
  posts, until the owner changes this line.
- Two setups posting from two ledgers put two numbered lists in one DM, and a reply
  meant for one lands on the other (2026-09-22).

## One agent at a time

- Two agents never edit this checkout at once. Before starting, run `git status` and
  `git log`; commit or stash before handing over.
- Don't trust memory of the code: another agent may have changed it since.

## Invariants: do not break these

- **The detector is deterministic.** Regex cues, no model judgement in `src/`. The
  skill fetches and posts; `slack-run.js` decides.
- **Connector responses are immutable inputs.** Never edit fetched Slack or calendar
  text, even to repair your own copying mistake. Fetch it again, rebuild that field, and
  say so under the digest.
- **No Slack app and no tokens.** Everything goes through the connector the user already
  has. Don't "fix" limits by introducing an app or a token.
- **A channel is not one relationship.** Conversation, ownership and attribution are
  decided per message and per commitment, never per channel.
- **Nothing real in the public repo.** Captures and fixtures go through
  `tools/sanitize-capture.js` first; no real emails, Slack IDs or names.

## Changing behaviour

- Show a plain-text draft of any output change and get approval before writing code.
- The detector is frozen between real runs. Change it only when a real run shows a
  genuine problem, and only the part that run shows.
- Every fix gets a regression test, and that test must fail with the fix reverted.
- Before committing: `npm test` (all suites, including both replays in `test/replay/`)
  passes.
- `SKILL.md` is the procedure the scheduled run follows. Its prompt only points there;
  never copy the procedure into it.
