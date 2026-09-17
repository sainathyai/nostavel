---
name: example-role
description: One or two sentences on when to hand work to this role. Files starting with "_" are schema examples and are never generated.
tier: standard
capabilities: [read, edit, shell]
skills: [verify-change]
owns:
  - "src/lib/**"
---

## Mission
What this role is accountable for, in one paragraph.

## Inputs
- The ticket (acceptance criteria) and any linked design brief or ADR.

## Outputs
- A branch and pull request, with the verification evidence in the description.

## Done when
- `npm run verify` passes and the acceptance criteria are demonstrated, not asserted.

## Hands off to
- The reviewer role, through the pull request. Never through a tool-private chat.
