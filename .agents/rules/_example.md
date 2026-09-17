---
name: example-area
description: What this rule covers. Files starting with "_" are schema examples and are never generated.
globs:
  - "src/lib/**/*.ts"
---

Source of truth: `docs/conventions.md` §1. (Every rule cites the sections it summarises.)

Short, imperative rules for anyone, human or agent, editing files that match the globs.
Summarise and link the conventions rather than restating them, so they stay the single
source of truth. The file name must equal `name` plus `.md`, and every glob must match at
least one tracked file.
