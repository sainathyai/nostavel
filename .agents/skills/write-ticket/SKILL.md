---
name: write-ticket
description: Turn a problem or a PRD slice into one ticket that meets the Definition of Ready - problem, Given/When/Then acceptance criteria, risk field, labels, size of a day or less - ready for the tech lead to break down. Use for every piece of work, including bugs.
license: Proprietary. See LICENSE.
compatibility: Works in any agent that can read files. Filing to the tracker needs the tracker tool server; without it, write the same text into the pull request body instead.
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
7. **Check it isn't already filed:** `tracker_search` on the words a duplicate would use.
   If one exists, update it (`tracker_update`) instead of filing a second.
8. **File it.** Write the body from `assets/ticket-template.md`, then `tracker_create`
   with the work type (`Bug`, `Story`, `Task`, `Spike` as a Task labelled `spike`), the
   title, the body as Markdown, the labels, and the parent epic if it has one. The tool
   returns the key; use it in the branch name and the pull request title.
9. **Set its state.** A ticket that meets the Definition of Ready goes to `Ready`
   (`tracker_transition`); anything else stays in `To Do` with the gap named in a comment.
10. **Hand off** to tech-lead: `tracker_comment` with a handoff block
    (`docs/team/workflow.md`). Without the tracker server, put the same text in the pull
    request body and say so.

## Quality bar
- An engineer could start without asking a question.
- QA could write a failing test from the criteria alone.
- The risk field and labels match what the change really touches.
