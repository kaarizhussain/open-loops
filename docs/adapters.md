# Pointing it at something else

The engine never touches a mail or chat API. An adapter produces two shapes and
nothing in `src/loops.js` changes.

[← README](../README.md)

---



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

**Slack is the one to use.** [`SLACK.md`](../SLACK.md) has it: the digest arrives as a DM
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
