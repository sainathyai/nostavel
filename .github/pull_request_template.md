<!--
Title format: NOS-<n> <what changed>
Keep the sections that apply; delete the ones that don't, rather than writing "n/a".
-->

**Ticket:** NOS-<n>

## What and why
<What this changes, and the problem it solves. One paragraph.>

## Risk
**Labels:** <money, security, ui, migration, ai, agent-layer>
**Required reviews for those labels:** <see docs/team/roles.md#review-gates>

<What could go wrong if this is wrong: money, a guest claim, access, data.>

## How this was verified

- [ ] `npm run verify` passed locally
- Commands run, and their **actual** results:
  ```
  ```
- **Checked by hand:** <URL and what to look at, screenshots for UI changes>
- **Not verified:** <what automation could not prove, and why>

## Migration
<Only for schema changes: the migration file, that it is additive, and the order it ships in. Otherwise delete.>

## Rollback
<How to undo this if it misbehaves after merge: revert, a flag, or a follow-up.>

## Handoff
<!-- docs/team/workflow.md. Delete if this was done by the owner. -->
```
From: <role>   To: <role or owner>
Artifact: <ticket, PR, doc>
Done: <what is finished>
Next: <what the next role does>
Blocked: <what is waiting, and on whom>
```
