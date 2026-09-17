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
| `roles/<role>.md` | neutral frontmatter (below) | no tool yet: per-tool files are generated once roles are added |
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
| Claude Code | adapter | `.claude/skills/`, `.claude/rules/`, `.claude/settings.json` (permissions + guard hook), `.mcp.json` |
| Gemini CLI | adapter | `.gemini/settings.json` (AGENTS.md context, guard hook, MCP servers) |
| Codex, Copilot, Cursor | read `AGENTS.md` (including the Rules index) and `.agents/skills` natively | hook, rule, role and MCP adapters added when the tool is adopted |

## Adding a tool

1. Add an adapter to `buildAdapters()` in `scripts/agents-sync.mjs`: its settings, a hook
   entry pointing at `scripts/agent-guards/hook.mjs`, and its MCP config.
2. If the tool's hook payload uses tool names the guard doesn't know, add them to
   `scripts/agent-guards/rules.mjs` with a normalization test.
3. Add a test to `scripts/agents-sync.test.mjs`, run `npm run agents:sync`, and commit the
   generated files.
