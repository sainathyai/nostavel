#!/usr/bin/env node
// Run one role from .agents/roles, from anywhere.
//
// WHY THIS EXISTS. A coding tool discovers its agents from the directory the
// session was started in. So the twelve roles are invisible to a session
// started anywhere other than this repository - and working on this repository
// through absolute paths from somewhere else is a perfectly ordinary thing to
// do. That happened on NOS-9: a `security`-labelled change went up with one
// pair of eyes, and the pull request said the roles were "not available", when
// in fact only one route to them was closed and the route this project
// actually uses - a headless run with the repo as the working directory - was
// open the whole time.
//
// The fix is to stop depending on where the session started. This script finds
// the repository from its own location, so `node scripts/agent-run.mjs` reaches
// the same roles whatever the caller's working directory is.
//
// NEUTRALITY. The roles, skills and rules stay neutral: this is an adapter, one
// per tool, exactly like the generated files under .claude/ and .gemini/. The
// role is named the same way for every tool; only RUNNERS knows how a
// particular binary is invoked. Adding a tool means adding an entry, not
// touching a role.
//
// Usage:
//   node scripts/agent-run.mjs --list
//   node scripts/agent-run.mjs --role code-reviewer --prompt "review PR #33"
//   node scripts/agent-run.mjs --role security-architect --prompt-file notes.md
//   node scripts/agent-run.mjs --role qa-engineer --prompt - < notes.md
//   node scripts/agent-run.mjs --role security-architect --read-only --prompt "..."
//   AGENT_TOOL=claude node scripts/agent-run.mjs --role tech-lead --prompt "..."
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadRoles, toolsFor } from "./agents-sync.mjs";

/** The repository, found from this file rather than from the caller's cwd. */
export function repoRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

// Read-only shell commands a role without `edit` may still run. The role's own
// PreToolUse hook already refuses mutating commands (scripts/agent-guards),
// so this is a second, narrower fence rather than the only one: a reviewer
// that cannot run `git diff` cannot review, and one that can run `git push`
// is not a reviewer.
export const READ_ONLY_SHELL = [
  "gh pr diff",
  "gh pr view",
  "gh pr checks",
  "git diff",
  "git log",
  "git show",
  "git status",
  "grep",
  "rg",
  "npm test",
  "npm run verify",
  "npx vitest run",
];

/**
 * Is this workspace trusted by Claude Code?
 *
 * THE SECOND REASON THE ROLES WERE UNREACHABLE on NOS-9, and the one with
 * teeth. An untrusted workspace has its `.claude/settings.json` ignored - and
 * that file is where the permissions live, alongside the PreToolUse hooks that
 * generated role files point at. So a headless run in an untrusted checkout
 * gets the role's PROMPT without the role's GUARD: `owns` is not enforced and
 * mutating shell commands are not blocked. A reviewer bounded by an explicit
 * allow-list is still safe; a role that can edit is not, and must not run.
 *
 * Returns null when it cannot tell, which is treated as untrusted: guessing
 * "trusted" is the one wrong answer here.
 */
export function claudeWorkspaceTrusted(root, home = process.env.USERPROFILE || process.env.HOME) {
  if (!home) return null;
  try {
    const config = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
    const want = root.replace(/\\/g, "/").toLowerCase();
    for (const [key, value] of Object.entries(config.projects ?? {})) {
      if (key.replace(/\\/g, "/").toLowerCase() === want) return value.hasTrustDialogAccepted === true;
    }
    return false; // never opened here
  } catch {
    return null;
  }
}

export const RUNNERS = {
  // Verified against Claude Code 2.1.276: `--agent <name>` makes the whole
  // headless session that role, with the role's own tools and hooks.
  claude: {
    bin: "claude",
    argv: ({ role, prompt, tools }) => [
      "-p",
      "--agent",
      role,
      ...(tools.length ? ["--allowedTools", ...tools] : []),
      "--",
      prompt,
    ],
    preflight: ({ root, capabilities }) => {
      if (claudeWorkspaceTrusted(root) === true) return { ok: true };
      const how =
        `Open Claude Code interactively in ${root} once and accept the trust dialog.\n` +
        `  That is the owner's decision to make, not this script's: trusting a workspace is\n` +
        `  what allows its hooks to execute.`;
      if (capabilities.includes("edit")) {
        return {
          ok: false,
          error:
            `this workspace is not trusted by Claude Code, so .claude/settings.json - and the\n` +
            `  role guard hook it carries - is ignored. A role with the "edit" capability would\n` +
            `  run with no \`owns\` enforcement and no block on mutating shell commands.\n  ${how}`,
        };
      }
      return {
        ok: true,
        warning:
          `workspace not trusted, so the role guard hook will not run. Safe here because this\n` +
          `  role cannot edit and the tool allow-list above is the fence, but fix it:\n  ${how}`,
      };
    },
  },
  // No Gemini CLI runner yet, on purpose. Its generated role files exist
  // (.gemini/agents), but the flag that selects one headlessly has not been
  // checked on a real install, and a guessed command line is worse than an
  // honest gap: it would fail at the moment someone needed a review. Add an
  // entry here once it has been run.
};

/** The role's frontmatter, or an error naming the roles that do exist. */
export function resolveRole(roles, name) {
  if (!name) return { ok: false, error: `--role is required. Roles: ${roleNames(roles).join(", ")}` };
  const role = roles.find((r) => r.data.name === name);
  if (!role) return { ok: false, error: `unknown role "${name}". Roles: ${roleNames(roles).join(", ")}` };
  return { ok: true, role };
}

export function roleNames(roles) {
  return roles.map((r) => r.data.name).sort();
}

/**
 * The tool allow-list for a role, from the capabilities its charter declares.
 * A role that cannot edit gets shell access narrowed to reading commands; a
 * role that can edit is trusted with the shell, because its `owns` globs and
 * the guard hook are what bound it.
 */
export function allowedToolsFor(tool, capabilities, { readOnly = false } = {}) {
  // `--read-only` drops `edit` whatever the charter says. Reviewing is a
  // read-only use of a role that can otherwise write: security-architect owns
  // `docs/security/**`, but running its review gate needs nothing but reading.
  // Being explicit about that is what makes it safe to run where the guard hook
  // is not active - the allow-list below becomes the fence.
  const caps = readOnly ? capabilities.filter((c) => c !== "edit") : capabilities;
  const canEdit = caps.includes("edit");
  const tools = toolsFor(tool, canEdit ? caps : caps.filter((c) => c !== "shell"));
  if (canEdit || !caps.includes("shell")) return tools;
  return [...tools, ...READ_ONLY_SHELL.map((c) => `Bash(${c}:*)`)];
}

export function buildArgv({ tool, role, prompt, tools }) {
  const runner = RUNNERS[tool];
  if (!runner) {
    const known = Object.keys(RUNNERS).join(", ") || "(none)";
    return { ok: false, error: `no runner for tool "${tool}". Runners: ${known}` };
  }
  return { ok: true, bin: runner.bin, argv: runner.argv({ role, prompt, tools }) };
}

export function parseArgs(argv) {
  const out = { tool: process.env.AGENT_TOOL || "claude" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--list") out.list = true;
    else if (a === "--role") out.role = argv[++i];
    else if (a === "--tool") out.tool = argv[++i];
    else if (a === "--prompt") out.prompt = argv[++i];
    else if (a === "--prompt-file") out.promptFile = argv[++i];
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--read-only") out.readOnly = true;
    else return { ...out, error: `unexpected argument "${a}"` };
  }
  return out;
}

function readPrompt(args) {
  if (args.promptFile) return readFileSync(args.promptFile, "utf8");
  if (args.prompt === "-") return readFileSync(0, "utf8");
  return args.prompt;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) fail(args.error);

  const root = repoRoot();
  const errors = [];
  const roles = loadRoles(root, errors);
  if (errors.length) fail(`problems in .agents/roles:\n` + errors.map((e) => `  - ${e}`).join("\n"));

  if (args.list) {
    for (const r of roles) {
      console.log(`${r.data.name.padEnd(20)} ${r.data.tier.padEnd(9)} ${r.data.capabilities.join(", ")}`);
    }
    return;
  }

  const resolved = resolveRole(roles, args.role);
  if (!resolved.ok) fail(resolved.error);

  const prompt = readPrompt(args);
  if (!prompt?.trim()) fail("a prompt is required: --prompt, --prompt-file, or --prompt - for stdin");

  const capabilities = args.readOnly
    ? resolved.role.data.capabilities.filter((c) => c !== "edit")
    : resolved.role.data.capabilities;
  const tools = allowedToolsFor(args.tool, resolved.role.data.capabilities, { readOnly: args.readOnly });
  const built = buildArgv({ tool: args.tool, role: args.role, prompt, tools });
  if (!built.ok) fail(built.error);

  // Printed before it runs, and without the prompt, so the record shows which
  // role ran with which tools without dumping a page of text into the log.
  console.error(`agent-run: ${args.role} via ${built.bin} in ${root}`);
  console.error(`agent-run: tools ${tools.join(" ")}`);

  const preflight = RUNNERS[args.tool].preflight?.({ root, capabilities });
  if (preflight && !preflight.ok) fail(preflight.error);
  if (preflight?.warning) console.error(`agent-run: WARNING ${preflight.warning}`);

  if (args.dryRun) return;

  const child = spawn(built.bin, built.argv, { cwd: root, stdio: ["ignore", "inherit", "inherit"], shell: false });
  child.on("error", (e) => {
    fail(
      e.code === "ENOENT"
        ? `${built.bin} is not on PATH. Install it, or pick another --tool.`
        : `could not start ${built.bin}: ${e.message}`,
    );
  });
  child.on("exit", (code) => process.exit(code ?? 1));
}

function fail(message) {
  process.stderr.write(`agent-run: ${message}\n`);
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
