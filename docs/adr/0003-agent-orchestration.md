# ADR 0003: How the agent roles run together

- **Status:** accepted
- **Date:** 2026-09-17
- **Scope:** Segment 2.5
- **Deciders:** owner (D-2.15 A); tech-lead and software-architect roles consulted

## Context

Twelve roles now exist as provider-neutral definitions (ADR 0001, ADR 0002). Work has to
move between them: a PRD becomes tickets, a ticket gets broken down, tests come first,
then implementation, then reviews. The mechanism must:
- work in more than one coding-agent tool (ADR 0001);
- work headless, so it can run later in CI or on a schedule;
- keep cost proportional to the work, on a small budget;
- leave a record a human or another tool can resume from.

## Options

| Option | Cost | Risk | Notes |
|---|---|---|---|
| Lead-driven delegation: the tech lead delegates one sub-task at a time to a role subagent; handoffs are written into the pull request or ticket | one agent at a time | the lead is a single point of coordination | works in Claude Code and Gemini CLI today, interactive or headless |
| Parallel "agent teams": roles run as simultaneous teammates with a shared task list and messaging | several agents at once; highest token use | experimental; one tool only; interactive only; state lives in the tool | more autonomous; useful for debates such as design reviews |
| External orchestrator script calling each role headlessly | per call | tool-specific glue to maintain | good fit for CI, which Segment 3 covers with the review action |

## Decision

Lead-driven delegation. Every role ends its turn with a **handoff block** (format in
`docs/team/workflow.md`) in the pull request or ticket. That record, not a conversation,
is the state of the work.

## Consequences

- **Good:** portable across tools, cheap, and fully auditable. The owner can read one
  pull request and see who did what and why.
- **Costs and trade-offs:** sub-tasks run one after another, not in parallel, and the
  tech lead is a bottleneck by design.
- **Follow-up work:** the Segment 2.7 dry run measures how long one real ticket takes
  end to end, and what it costs.

## Revisit when

After the 2.7 dry run, or if parallel teammates leave experimental status and become
available in more than one tool.
