---
name: break-down-work
description: Turn a Ready ticket into an ordered list of sub-tasks, each with one owning role, a done-when and its blockers, plus the labels the change will carry and the review gates that follow. Use before implementation starts, and to re-plan when work is blocked.
license: Proprietary. See LICENSE.
compatibility: Works in any agent that can read files and run read-only status commands.
metadata:
  owner: nostavel
  role: tech-lead
  version: "1"
---

# Break down work

## Steps

1. **Check the ticket is Ready** (`docs/team/workflow.md`). If it isn't, say exactly what
   is missing and hand it back to product-manager rather than guessing.
2. **Read the code the change will touch,** and the area rules for those paths. The
   breakdown must match how this codebase is actually layered (conventions §1), not a
   generic plan.
3. **Decide what has to be decided first.** If the change crosses layers, adds a
   dependency or changes data shape, the first sub-task is an ADR by software-architect.
   If it touches auth, payments, personal data or headers, add a threat model or security
   review by security-architect. If a guest sees it, add a design brief by ux-designer.
4. **Split into sub-tasks of a day or less.** Order them so each one can be merged on its
   own without leaving the product broken. Say explicitly when two must ship together
   (for example a status change and the sweeper that acts on it).
5. **Assign one owning role per sub-task**, from `docs/team/roles.md`, respecting what each
   role may edit. A sub-task that spans two roles' files is two sub-tasks.
6. **Put tests first.** For anything with logic, qa-engineer writes failing tests before
   the engineering role starts.
7. **Set labels and gates.** Choose the labels the change will carry, and list the reviews
   they trigger (review gates table in `docs/team/roles.md`).
8. **Write the breakdown** on the ticket or pull request using the format below, then
   delegate the first sub-task, recording a handoff block
   (`docs/team/workflow.md`).

## Breakdown format

```
Breakdown for NOS-<n>
Labels: <labels>   Gates: <reviews required>

1. <sub-task>  - role: <role>  - done when: <observable>  - blocks: <none | #n>
2. …

Ships together: <sub-tasks that must merge in one pull request, and why>
Open decisions: <decision briefs for the owner>
```

## Quality bar
- Every sub-task has one role, one done-when, and no hidden dependency.
- Nothing is assigned to a role that can't edit those files.
- The riskiest, least understood piece is first, not last.
