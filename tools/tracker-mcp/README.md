# tracker-mcp

The team's ticket tracker, exposed to any agent tool over [MCP](https://modelcontextprotocol.io).
Roles reference it as the capability `mcp:tracker` (see [.agents/README.md](../../.agents/README.md)).

Today it talks to Jira Cloud. Tool names and arguments are the team's own vocabulary, not
Jira's, so a role or skill never learns a vendor's terms and a different tracker is one
adapter away.

## Tools

| Tool | Does |
|---|---|
| `tracker_search` | Find issues by text, status, type, labels or parent |
| `tracker_get` | Read one issue, description included, as Markdown |
| `tracker_create` | File an issue (`Epic`, `Story`, `Bug`, `Task`, `Subtask`), body in Markdown |
| `tracker_update` | Change title, body or labels |
| `tracker_transition` | Move to a status by name; errors list what is allowed from here |
| `tracker_comment` | Append a comment, in Markdown — where handoff blocks go |
| `tracker_link_pr` | Attach a pull request URL to the issue |

There is deliberately **no delete**, and no access to users, permissions or site settings.

## Layout

| File | Holds |
|---|---|
| `index.ts` | MCP wiring, the tool list, and argument checking |
| `tracker.ts` | The contract an adapter implements, in the team's vocabulary |
| `jira.ts` | The Jira Cloud adapter |
| `adf.ts` | Markdown ↔ Atlassian Document Format |
| `config.ts` | Credentials, read from `.env.local` |
| `check.ts` | `npm run tracker:check`: is it reachable, is the project set up |

## Credentials

`JIRA_SITE`, `JIRA_EMAIL` and `JIRA_API_TOKEN` live in `.env.local`, added by hand (see
`.env.example`). This server reads them itself. They are deliberately **not** put in the
agent tool's MCP config, so the token never enters an agent's environment where a shell
command could print it, and agents are already blocked from reading env files.

The token is an Atlassian API token with scopes (`read:jira-work`, `write:jira-work`,
`read:jira-user`), created at id.atlassian.com. Scoped tokens only work against
`api.atlassian.com/ex/jira/<cloudId>`, which is why the adapter resolves the cloud id
from the site rather than calling the site host directly.

## Safety

- **One project.** `TRACKER_PROJECT` (default `NOS`) is an allowlist: every key is checked
  against it, and new issues are forced into it.
- **No destructive operations** exist in the tool surface at all.
- **Errors are scrubbed** of the credential before they can reach a transcript.
- **Free-plan aware:** transitions are made by the roles, not by Jira automation rules,
  which the free plan limits to 100 runs a month.

## Running and testing

```
node tools/tracker-mcp/index.ts     # Node 24 runs TypeScript directly; no build step
npm run tracker:check               # connectivity and project sanity, prints no secrets
npx vitest run tools                # unit tests, no network
```

Tests use a fake Jira, so they need neither credentials nor the network, and they run in
CI as part of `npm run verify`.
