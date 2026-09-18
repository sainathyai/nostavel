---
name: write-ticket
description: Turn a problem or a PRD slice into one ticket that meets the Definition of Ready - problem, Given/When/Then acceptance criteria, risk field, labels, size of a day or less - ready for the tech lead to break down. Use for every piece of work, including bugs.
license: Proprietary. See LICENSE.
compatibility: Works in any agent that can read files. Writing to the tracker needs its tool server; until then the ticket text goes in the pull request body or an issue comment.
metadata:
  owner: nostavel
  role: product-manager
  version: "1"
---

# Write a ticket

## Steps

1. **Confirm the facts.** Read the code involved. For a bug, state what happens now, what
   should happen, and how to reproduce it. Don't restate a bug report you haven't checked.
2. **Size it.** One ticket is a day or less. If it's bigger, split it and say what order
   the pieces go in. A ticket that can't be split is a spike: its output is a written
   answer, not code.
3. **Write acceptance criteria** as Given / When / Then, each independently testable, and
   include the unhappy paths. Criteria describe behaviour, never implementation.
4. **Set the risk field:** `money`, `guest-claim`, `security` or `none`. This drives the
   review gates.
5. **Add labels** the change will carry: `money`, `security`, `ui`, `migration`, `ai`,
   `agent-layer`, plus `needs-design` or `needs-adr` when the work needs a brief or a
   decision first.
6. **Check the Definition of Ready** (`docs/team/workflow.md`). If anything is missing,
   the ticket is not Ready; say what's missing.
7. **Write it** from `assets/ticket-template.md`. Post it to the tracker when the tracker
   tool server is available; otherwise put it in the pull request body or an issue
   comment and link it from the ticket list.
8. **Hand off** to tech-lead with a handoff block (`docs/team/workflow.md`).

## Quality bar
- An engineer could start without asking a question.
- QA could write a failing test from the criteria alone.
- The risk field and labels match what the change really touches.
