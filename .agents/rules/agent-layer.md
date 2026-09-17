---
name: agent-layer
description: The provider-neutral agent layer (skills, roles, rules, policy, guards) and the files generated from it. Read before editing any agent configuration.
globs:
  - ".agents/**"
  - "scripts/agent-guards/**"
  - "scripts/agents-sync.mjs"
  - ".claude/**"
  - ".gemini/**"
  - ".mcp.json"
---

# Agent layer rules

Source of truth: `.agents/README.md` and `docs/adr/0001-provider-neutral-agent-layer.md`. This layer follows the repository conventions in `docs/conventions.md` (§6 tests, §10 comments).

## Sources and generated files
- **Edit the sources only:** `.agents/skills`, `.agents/rules`, `.agents/roles`, `.agents/policy.json`, `.agents/mcp.json`, `.agents/models.json`.
- **Never edit generated files by hand:**
  - `.claude/skills/`, `.claude/rules/`, `.claude/settings.json`
  - `.gemini/settings.json`, `.mcp.json`
  - the Rules index block in `AGENTS.md`
- After changing a source, run `npm run agents:sync` and commit the generated output in the same change. `npm run agents:check` fails CI otherwise.

## Neutrality
- **Skills:** only Agent Skills standard fields (`name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`). `name` matches the folder.
- **Roles:** declare a tier (`deep`, `standard`, `fast`), never a model. Provider models are named only in `models.json`.
- **Rules:** `name`, `description`, `globs`. Every glob must match at least one tracked file, and the body cites the conventions section it summarises.
- **Bodies describe capabilities** ("run the test suite", "hand off to the reviewer role"), never one tool's internal tool names, argument placeholders or inline command syntax.
- **Tool-specific extras** go in `skills/<name>/adapters/<tool>.json`, and the skill must still work without them.

## Guards
- `scripts/agent-guards/rules.mjs` holds the rules and is pure; `hook.mjs` is the entry point every tool's hook calls.
- Secret and path patterns live in `scripts/agent-guards/patterns.mjs`, shared with the git pre-commit guard. Add a pattern there once and both enforce it.
- **Every guard change needs tests** for the block and its allowed look-alike.
- **Never weaken a guard to get unblocked.** If a guard blocks legitimate work, fix the rule, with a test, in its own change.
- The guard fails open on internal errors by design. Git hooks, CI and the `main` ruleset are the backstop.

## Adding a tool
Follow "Adding a tool" in `.agents/README.md`: add an adapter in `buildAdapters()`, normalize any new hook tool names, add tests, sync, and commit.
