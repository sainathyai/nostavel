---
name: write-runbook
description: Write or update an operational runbook - deploy, rollback, rotate a secret, handle an incident - so the owner can follow it under pressure without reading the code. Use when a new operational path appears, or after an incident showed the steps were missing or wrong.
license: Proprietary. See LICENSE.
compatibility: Works in any agent that can read and write files. Verifying steps needs a shell.
metadata:
  owner: nostavel
  role: devops-sre
  version: "1"
---

# Write a runbook

The reader is the owner, at 2 a.m., on a phone, with something broken. They are not going
to read source code, and they should not have to think about how anything works.

## Steps

1. **Name the situation, not the system.** "Guests see an error on the booking page", not
   "Cloud Run revision failure". The reader knows the symptom, not the cause.
2. **Put the stop-the-bleeding step first.** If there is a kill switch, a rollback or a
   way to stop taking money, it goes at the top, before any diagnosis.
3. **Number the steps.** Each one has: the exact command to run, what a healthy result
   looks like, and what to do when it isn't healthy. No step may be "investigate".
4. **Write commands to copy.** Full commands with real flags. Where a value must be filled
   in, show it as `<booking-id>` and say where to find it.
5. **Say what not to do**, where a plausible action would make things worse: never edit
   `booking_events` rows, never `db:push`, never force-push `main`.
6. **Name who to tell,** and what to record: which events, which ticket, which channel.
7. **Verify the steps.** Run the read-only ones for real, and say in the runbook which
   steps have been rehearsed and which are still theory. An unrehearsed step is marked
   as such rather than quietly trusted.
8. **File it** as `docs/runbooks/<situation>.md`, and link it from the ticket and from any
   check or alert that would send someone there.

## Structure

```
# <Situation, in the reader's words>

**Stop the bleeding:** <the one action that limits harm, or "none - this is not urgent">

## Symptoms
## Steps
1. <command> - healthy: <what you should see> - if not: <what to do>
## Do not
## Afterwards
<what to record, who to tell, which ticket>
**Rehearsed:** <which steps have actually been run, and when>
```

## Quality bar
- Someone who has never read this codebase could follow it.
- Every step has a healthy-result check; none says "investigate" or "check the logs".
- The destructive things that look tempting are explicitly listed as not to do.
