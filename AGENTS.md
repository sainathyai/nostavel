<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Conventions

Read `docs/conventions.md` before writing code in this repo. It is short, and
every rule in it exists because breaking it already caused a bug here.

The three that catch people most often:

1. **Pure rules import nothing.** If a unit test needs a database to import a
   rule, the rule is in the wrong file. Rules live in `lib/<name>.ts`, queries in
   `lib/<name>-store.ts`.
2. **Never compare money across bases.** A rate is not a total. A saving may only
   be claimed against sourced evidence, never against supplier net.
3. **Verify by running it, not by rendering it.** `npm test`, `npx tsc --noEmit`,
   `npm run lint`, `npm run build`, and then actually exercise the page. Several
   bugs here returned a clean 200 and were still broken.

# Team workflow

This repository is worked on by humans and by coding agents from any provider.
The same rules apply to both.

- **The tracker owns scope; the pull request owns the change.** Work starts from a
  ticket (`NOS-<n>`) and lands through a pull request. Never commit to `main`; branch as
  `NOS-<n>-short-slug`. The human owner merges.
- **Done means verified.** Run `npm run verify` (or the `verify-change` skill) before
  calling anything done, then state what still needs a human check.
- **Hand off through durable artifacts** (ticket comment, design brief, ADR, pull
  request), never through a tool-private conversation, so any agent or person can pick
  the work up.
- **Decisions:** when a choice is needed, end the message with a short decision brief:
  an ID, 2–3 options, a recommendation, and the default that applies if nobody answers.
  Settled engineering decisions become ADRs in `docs/adr/`.

# Agent layer (provider-neutral)

Skills, roles, rules and guardrails are written once, in neutral formats, and generated
into each tool's config. See `.agents/README.md` and
`docs/adr/0001-provider-neutral-agent-layer.md`.

| Source (edit these) | Generated (never edit by hand) |
|---|---|
| `.agents/skills/<name>/SKILL.md` (Agent Skills standard) | `.claude/skills/` |
| `.agents/policy.json` | `.claude/settings.json`, `.gemini/settings.json` |
| `.agents/mcp.json` | `.mcp.json`, `.gemini/settings.json` |
| `.agents/roles/`, `.agents/rules/`, `.agents/models.json` | per-tool role and rule files, as they are added |

After editing a source, run `npm run agents:sync`. CI fails if generated files drift.

Guardrails are enforced by `scripts/agent-guards/hook.mjs`, which every tool's pre-tool
hook calls. The git pre-commit guard and CI back it up for everything else.

## Rules index

Area rules live in `.agents/rules/`. Before editing files that match an area's globs,
read that area's rule file. Area rules arrive in the next step; `_example.md` shows the
format.
