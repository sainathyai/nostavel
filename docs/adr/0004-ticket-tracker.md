# ADR 0004: Ticket tracker and how agents reach it

- **Status:** accepted
- **Date:** 2026-09-21
- **Scope:** Segment 2.6
- **Deciders:** owner; tech-lead role consulted

## Context

The roles hand work to each other through durable artifacts (ADR 0002, ADR 0003). Until
now the only durable place was the pull request, which cannot hold work that has no branch
yet: a backlog, a breakdown, a bug found during review. The team needs a tracker, and the
agent roles need to reach it the same way from any coding-agent tool (ADR 0001).

Constraints: no monthly spend; one human owner plus agent roles; the tracker must not
become a place where an agent can do damage.

## Options

| Option | Cost | Risk | Notes |
|---|---|---|---|
| Jira Free + our own tool server over its REST API | $0 | we maintain a small server | Full control of the tool surface; free plan gives 10 users, 2 GB, 100 automation runs a month |
| Jira Free + Atlassian's official Rovo MCP server | $0 plus Rovo credits for some tools | availability on the free plan is undocumented; needs an org admin to enable token auth; broad tool surface including deletes | Less to maintain, but the tool surface is theirs, not ours, and it names Jira everywhere |
| GitHub Issues + the GitHub MCP server | $0 | issues and pull requests in one place makes "ticket owns scope, pull request owns change" harder to keep | Would need no new credentials |
| No tracker; keep everything in pull requests | $0 | backlog and cross-cutting work stay invisible | Where we were |

## Decision

**Jira Free, reached through our own `tracker` tool server** (`tools/tracker-mcp`).

- The tool surface is the team's own vocabulary — `tracker_create`, `tracker_transition` —
  with Jira behind a `Tracker` interface. Roles and skills name no vendor, so switching
  trackers is one adapter, not a rewrite of the agent layer.
- The surface is exactly the seven operations the workflow needs. There is **no delete**
  and no access to users, permissions or site settings.
- The project key is an allowlist, so a role cannot touch another project on the site.
- Ticket bodies are written in Markdown, like everything else in this repository, and
  converted to Jira's document format by `adf.ts`.
- Credentials live in `.env.local` and are read by the server process itself, never passed
  through an agent tool's configuration or environment.
- Only product-manager and tech-lead hold `mcp:tracker`. Other roles receive ticket text
  and answer in their pull request, which keeps authorship of scope in one place.

## Consequences

- We maintain roughly 600 lines of adapter, with tests against a fake Jira (no network).
- Status moves are made by the roles, not Jira automation rules: the free plan allows 100
  rule runs a month, and an explicit transition is easier to audit anyway.
- The free plan's limits (10 users, 2 GB) are far above a solo owner plus agents. If the
  site ever needs more, the decision to revisit is the plan, not the tracker.
- If Atlassian's official server later documents free-plan support and a scoped,
  non-destructive tool set, revisit: it would remove code we maintain. Our roles would not
  change, because they depend on the capability name, not the server.

## Revisit when

Segment 3 adds CI automation that needs tracker writes from a workflow, or the tool
surface needs an operation these seven do not cover.
