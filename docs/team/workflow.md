# Team workflow

How work moves between the roles in [roles.md](roles.md). This page is an outline: it is
completed in Segment 2.7, once one real ticket has run through the whole chain.

## The tracker

Tickets live in the `NOS` project of the team's tracker, reached through the `tracker` tool
server ([tools/tracker-mcp](../../tools/tracker-mcp/README.md)). product-manager and
tech-lead have that capability; every other role reads the ticket text handed to it and
replies in its pull request.

| Status | Means |
|---|---|
| **To Do** | Filed, not yet Ready: something in the Definition of Ready is missing |
| **Ready** | Meets the Definition of Ready; the tech lead can break it down |
| **In Progress** | Broken down, sub-tasks being worked |
| **In Review** | A pull request is open and `npm run verify` passed |
| **Done** | Merged by the owner, and released where applicable |

The ticket key drives the rest: branch `NOS-<n>-short-slug`, pull request title starting
`NOS-<n>`, which is what links the change back to the ticket.

## Lifecycle

| Stage | Entry condition | Roles | Artifact produced |
|---|---|---|---|
| **Idea** | The owner or any role raises a problem | product-manager | — |
| **Backlog** | A ticket exists | product-manager | Ticket; PRD for anything larger than a day (`docs/prd/NOS-<n>.md`) |
| **Ready** | Meets the Definition of Ready (below) | tech-lead; software-architect, ux-designer and security-architect as needed | Breakdown comment, labels; ADR, design brief or threat model where needed |
| **In progress** | A role picks up a sub-task | qa-engineer (tests first), then the engineering role | Branch `NOS-<n>-short-slug`, commits |
| **In review** | A pull request is open and `npm run verify` passed | code-reviewer plus label gates ([roles.md](roles.md#review-gates)) | Reviews on the pull request |
| **Ready to merge** | All required reviews approve, CI green | the owner | Merge (squash) |
| **Done** | Merged, and released where applicable | devops-sre; product-manager closes the ticket | Release notes |

## Definition of Ready
- The problem and who it is for are stated.
- Acceptance criteria are written as Given / When / Then and are testable.
- The risk field is set: `money`, `guest-claim`, `security` or `none`.
- The work is split into pieces of a day or less.
- Open questions are listed, and any that block have a decision brief.

## Definition of Done
- Every acceptance criterion has a test, or a recorded manual check with evidence.
- `npm run verify` passes locally and in CI.
- The required reviews for the pull request's labels have approved.
- Guest-visible changes: the owner has checked the URL they were given.
- The pull request says what was verified and what was not.

## Handoff artifacts

| Artifact | Location | Written by |
|---|---|---|
| PRD | `docs/prd/NOS-<n>.md` | product-manager |
| Design brief | `docs/design/NOS-<n>.md` | ux-designer |
| Architecture decision | `docs/adr/NNNN-<slug>.md` | software-architect |
| Threat model | `docs/security/NOS-<n>.md` | security-architect |
| Change record | pull request description | the authoring role |
| Status and handoffs | tracker comments | every role (through the lead when a role has no tracker capability) |

## How the roles run together

**Lead-driven delegation** ([ADR 0003](../adr/0003-agent-orchestration.md)):
- The tech-lead role runs in the main session. It breaks the ticket down
  (`break-down-work`), then delegates one sub-task at a time to the owning role, running
  that role as a subagent in whatever tool is in use.
- Each role does its sub-task within its boundaries, and finishes with a **handoff block**.
- The tech lead reads the block and delegates the next sub-task, or stops with a decision
  brief for the owner.
- Reviews run the same way: the reviewer roles are delegated to after the pull request
  exists.
- Nothing depends on one tool's conversation state. The state of the work is in the
  artifacts, so another tool, another model or the owner can pick it up at any handoff.

### Handoff block

Every role ends its turn by appending this to the pull request or ticket:

```
Handoff: <from-role> -> <to-role | owner>
Ticket: NOS-<n>
Done: <what this role finished, with artifact links>
Evidence: <commands run and results, or "docs only">
Next: <the next sub-task, or the review requested>
Blocked: <none | what, and the decision brief ID>
```

## Human checkpoints
- **Decision briefs:** an ID, 2–3 options, a recommendation and the default if unanswered.
  Only truly blocking questions wait for an answer.
- **Merges:** always the owner.
- **Visual checks:** a URL plus exactly what to look at (both themes, phone width, keyboard).
- **Secrets, repository settings, paid services, production and the money gate:** the
  owner only.

## To be completed in 2.7
- Tracker automation (the free plan allows 100 rule runs a month, so transitions are made by the roles, not by rules).
- Pull request template and CODEOWNERS.
- A worked example: bug 6 (the AI prompt's date is fixed at server start) run end to end.
