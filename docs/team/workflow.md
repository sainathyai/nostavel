# Team workflow

How work moves between the roles in [roles.md](roles.md). This page is an outline: it is
completed in Segment 2.7, once the tracker exists and one real ticket has run through the
whole chain.

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
| Status and handoffs | tracker comments (pull request comments until the tracker exists) | every role |

## Human checkpoints
- **Decision briefs:** an ID, 2–3 options, a recommendation and the default if unanswered.
  Only truly blocking questions wait for an answer.
- **Merges:** always the owner.
- **Visual checks:** a URL plus exactly what to look at (both themes, phone width, keyboard).
- **Secrets, repository settings, paid services, production and the money gate:** the
  owner only.

## To be completed in 2.7
- Tracker workflow states and automation.
- How the tech lead drives the other roles (decided in 2.5).
- Pull request template and CODEOWNERS.
- A worked example: bug 6 (the AI prompt's date is fixed at server start) run end to end.
