# Provider-neutral agent layer

Everything an AI coding agent needs to work in this repository (skills, roles, area rules,
guardrails, tool servers) is written here **once**, in formats no single provider owns.
`npm run agents:sync` generates each tool's own config from it. For the reasoning, see
[ADR 0001](../docs/adr/0001-provider-neutral-agent-layer.md).

## Layout

| Path | Format | Read natively by |
|---|---|---|
| `../AGENTS.md` | [AGENTS.md](https://agents.md) (Linux Foundation, Agentic AI Foundation) | Codex, Copilot, Cursor; Gemini CLI via generated `context.fileName`; Claude Code via `CLAUDE.md` = `@AGENTS.md` |
| `skills/<name>/SKILL.md` | [Agent Skills](https://agentskills.io/specification), standard fields only | Codex, Gemini CLI, Copilot, Cursor; Claude Code via the generated `.claude/skills/` copy |
| `roles/<role>.md` | neutral frontmatter (below) | Claude Code via generated `.claude/agents/`; Gemini CLI via generated `.gemini/agents/` |
| `rules/<area>.md` | `name` (= file name), `description`, `globs` + body citing `docs/conventions.md` §n | Claude Code via generated `.claude/rules/` (`paths`); every other tool via the generated Rules index in `AGENTS.md` |
| `policy.json` | denied paths and commands, ask-first and allowed commands | generated into each tool's permissions |
| `mcp.json` | MCP servers: `{command, args, env}` or `{url}` | generated into each tool's MCP config |
| `models.json` | tier → model per tool | the **only** place provider models are named |

Files whose names start with `_` are format examples and are never generated.

## Neutrality rules (`npm run agents:check` enforces what it can)

1. **Skills use only Agent Skills standard fields:** `name` (matches the folder),
   `description`, `license`, `compatibility`, `metadata`, `allowed-tools`.
2. **Roles declare a tier** (`deep`, `standard`, `fast`), never a model.
3. **No tool-specific syntax in bodies.** No provider model IDs, and none of one tool's
   argument placeholders, inline command execution or internal tool names. Describe
   the capability instead ("run the test suite", "delegate to the reviewer role").
4. **Tool-specific extras** go in an optional sidecar,
   `skills/<name>/adapters/<tool>.json`. It is merged into that tool's copy only, and
   the neutral skill must still work without it.
5. **Guardrails are plain Node scripts** (`scripts/agent-guards/`) with tests. Every
   tool's hook calls the same script. Git hooks and CI remain the backstop for any tool
   whose hooks are missing or bypassed.

## Role file format

```yaml
---
name: backend-engineer            # lowercase-hyphenated
description: When to hand work to this role.
tier: standard                    # deep | standard | fast  (see models.json)
capabilities: [read, edit, shell] # read | edit | shell | web | mcp:<server>
skills: [verify-change]           # skills this role uses
owns:                             # globs this role is accountable for
  - "src/lib/**"
---
Mission, inputs, outputs, done-when, hands-off-to.
```

## Supported tools

| Tool | Status | Generated files |
|---|---|---|
| Claude Code | adapter | `.claude/skills/`, `.claude/rules/`, `.claude/agents/` (subagents with a role-scoped guard hook), `.claude/settings.json` (permissions + guard hook), `.mcp.json` |
| Gemini CLI | adapter | `.gemini/settings.json` (AGENTS.md context, guard hook, MCP servers), `.gemini/agents/` (subagents) |
| Codex, Copilot, Cursor | read `AGENTS.md` (including the Rules index) and `.agents/skills` natively | hook, rule, role and MCP adapters added when the tool is adopted |

## Roles in each tool

A role is a neutral definition (`roles/<role>.md`) that the generator turns into each tool's subagent. Charters: `docs/team/roles.md`.

| | Claude Code | Gemini CLI |
|---|---|---|
| Run a role | ask for the role by name ("use the backend-engineer subagent to…"), or `claude --agent backend-engineer` | `@backend-engineer …`, or let the main agent delegate |
| Tools | capabilities mapped to Claude tool names | capabilities mapped to Gemini tool names |
| Model | tier → alias from `models.json` | `inherit`, unless `models.json` gives an exact Gemini model id |
| Skills | preloaded from the role's `skills` | discovered from `.agents/skills` |
| `owns` (edit boundary) | **enforced**: the subagent's own hook calls the guard with `--role` | **advisory only**: Gemini subagent files have no hooks. The session guard, git hooks and CI still apply |
| Read-only roles (no `edit`) | mutating shell commands blocked by the role guard | advisory only |

Capability → tool mapping lives in `TOOL_MAP` in `scripts/agents-sync.mjs`. A role never names tools itself.

## Known limits (verified 2026-09-17)

- **Tool servers in headless Claude Code on this Windows machine.** The standalone CLI
  (2.1.96) exposed no MCP tools in `-p` runs, even with the server pre-approved
  (`enabledMcpjsonServers`), passed with `--mcp-config`, or wrapped in `cmd /c npx`, while
  `claude mcp list` reported it connected. Roles that need the browser (`ui-reviewer`,
  `ux-designer`, `frontend-engineer`) therefore run in an interactive session for now.
  Re-check after a CLI update.
- **Gemini CLI subagents** have no per-agent hooks, so `owns` is advisory there (see above).
- **The read-only shell rule is a deny-list:** defence in depth, not a sandbox. Git hooks,
  CI and review remain the backstop.

## Adding a tool

1. Add an adapter to `buildAdapters()` in `scripts/agents-sync.mjs`: its settings, a hook
   entry pointing at `scripts/agent-guards/hook.mjs`, and its MCP config.
2. If the tool's hook payload uses tool names the guard doesn't know, add them to
   `scripts/agent-guards/rules.mjs` with a normalization test.
3. Add a test to `scripts/agents-sync.test.mjs`, run `npm run agents:sync`, and commit the
   generated files.
