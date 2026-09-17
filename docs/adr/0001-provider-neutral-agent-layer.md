# ADR 0001: Provider-neutral agent layer

- **Status:** accepted
- **Date:** 2026-09-16
- **Scope:** Segment 2 (team workflow), sub-step 2.1

## Context

A team of AI agent roles will work on this repository alongside its human owner: designer,
frontend and backend engineers, software and security architects, PM, tech lead, QA,
reviewers, DevOps/SRE and an AI engineer. The owner requires those skills and roles to be
**transferable between LLM providers and coding-agent tools**, not locked to one vendor.

What had an open standard as of 2026-09-16:

| Concern | Open standard | Notes |
|---|---|---|
| Project instructions | AGENTS.md (Linux Foundation, Agentic AI Foundation) | Read natively by Codex, Copilot and Cursor; Gemini CLI via `context.fileName`; Claude Code via an `@AGENTS.md` import |
| Skills | Agent Skills (`SKILL.md`, agentskills.io) | `.agents/skills` is read by Codex, Gemini CLI, Copilot and Cursor; Claude Code reads `.claude/skills` only |
| Tool servers | Model Context Protocol (Linux Foundation, Agentic AI Foundation) | Every major tool is a client, but config file formats differ |
| Roles / subagents | none | Claude `.claude/agents`, Copilot `.github/agents`, Gemini `.gemini/agents`, Codex `.codex/agents` (TOML) |
| Path-scoped rules | none | Claude `paths`, Copilot `applyTo`, Cursor `globs` |
| Hooks | none | All major tools have pre-tool hooks; payloads and configs differ |

## Decision

1. **Single neutral source.** `AGENTS.md` plus `.agents/` (skills, roles, rules, policy,
   MCP servers, model tiers) is the only place any of these are written.
2. **Generated adapters, committed.** `scripts/agents-sync.mjs` writes each tool's files.
   They are committed so fresh clones and CI jobs work without a build step, and
   `npm run agents:check` fails CI when they drift from the sources.
3. **Standard fields only in neutral files.** Tool-specific extras go in per-tool sidecars
   that are merged into that tool's copy only.
4. **Model tiers, not model names.** Roles say `deep`, `standard` or `fast`, and
   `models.json` maps each tier to a model for each tool.
5. **One guard for every tool.** `scripts/agent-guards/hook.mjs` accepts any supported
   tool's pre-tool payload and normalizes it. To block, it exits with code 2 and writes the
   reason to stderr, a contract Claude Code and Gemini CLI both use. Its secret and path
   rules are shared with the git pre-commit guard (`scripts/agent-guards/patterns.mjs`).
6. **Defence in depth.**
   - Tool permission lists, generated from `policy.json`, are a first, cheaper layer.
   - The guard script is the enforcement layer on the agent side.
   - The git pre-commit guard, CI and the `main` branch ruleset enforce the rules for
     every tool, including tools without hooks, and for humans.
7. **First two tools:** Claude Code (primary) and Gemini CLI, which has a free tier and
   reads `.agents/skills` natively. Other tools get adapters when adopted.

## Consequences

- Adding a tool means writing an adapter function with tests. Skills and roles don't need
  rewriting.
- Pull requests that change `.agents/` also carry the regenerated files, which adds diff
  noise.
- Tool-specific features (such as forked skill context or per-tool subagent options) are
  only used through sidecars. The neutral behaviour has to stand without them.
- The guard fails open on malformed input or an internal error, so a broken guard never
  stops all work. Git hooks, CI and the ruleset still catch what it misses.
- Claude Code has no native OS sandbox on Windows, so the guard and the server-side rules
  are the real boundary on this machine.

## Alternatives considered

- **Author directly in `.claude/`.** Fastest, but it locks roles and skills to one tool.
- **Symlink `.claude/skills` to `.agents/skills`.** Needs admin rights or Developer Mode on
  Windows, and can't carry tool-specific extras. Generating copies avoids both problems.
- **Generate on `npm install` instead of committing.** Cleaner diffs, but CI and tools that
  start before install would see no config.
