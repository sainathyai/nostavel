import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  RUNNERS,
  allowedToolsFor,
  buildArgv,
  claudeWorkspaceTrusted,
  parseArgs,
  repoRoot,
  resolveRole,
  roleNames,
} from "./agent-run.mjs";

const roles = [
  { data: { name: "code-reviewer", tier: "standard", capabilities: ["read", "shell"] } },
  { data: { name: "backend-engineer", tier: "standard", capabilities: ["read", "edit", "shell"] } },
  { data: { name: "product-manager", tier: "standard", capabilities: ["read", "web", "mcp:tracker"] } },
];

// ---------------------------------------------------------------------------
// The whole point of the script: the roles are found from the repository, not
// from wherever the caller happened to be standing. On NOS-9 a security change
// shipped with one reviewer because the session had started in another
// directory and the roles were therefore invisible.
// ---------------------------------------------------------------------------
test("finds the repository from the script's own location, not the cwd", () => {
  const root = repoRoot();
  assert.ok(existsSync(join(root, ".agents", "roles")), `${root} should hold .agents/roles`);
  assert.ok(existsSync(join(root, "package.json")));
});

test("names an unknown role's alternatives instead of failing blankly", () => {
  const bad = resolveRole(roles, "reviewer");
  assert.equal(bad.ok, false);
  assert.match(bad.error, /unknown role "reviewer"/);
  assert.match(bad.error, /code-reviewer/);

  const missing = resolveRole(roles, undefined);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /--role is required/);

  assert.equal(resolveRole(roles, "code-reviewer").ok, true);
  assert.deepEqual(roleNames(roles), ["backend-engineer", "code-reviewer", "product-manager"]);
});

// ---------------------------------------------------------------------------
// A role's charter decides what it may hold. A reviewer with Write is not a
// reviewer, and a reviewer that cannot run `git diff` cannot review.
// ---------------------------------------------------------------------------
test("a role without edit gets no writing tools and a read-only shell", () => {
  const tools = allowedToolsFor("claude", ["read", "shell"]);
  assert.ok(tools.includes("Read"));
  assert.ok(!tools.includes("Edit"), "a reviewer must not get Edit");
  assert.ok(!tools.includes("Write"), "a reviewer must not get Write");
  assert.ok(!tools.includes("Bash"), "bare Bash would allow any command");
  assert.ok(tools.includes("Bash(git diff:*)"), "but it must be able to read the change");
  assert.ok(tools.some((t) => t.startsWith("Bash(gh pr diff")));
});

test("a role with edit keeps the shell, because its owns globs and the guard bound it", () => {
  const tools = allowedToolsFor("claude", ["read", "edit", "shell"]);
  assert.ok(tools.includes("Edit"));
  assert.ok(tools.includes("Write"));
  assert.ok(tools.includes("Bash"));
  assert.ok(!tools.some((t) => t.startsWith("Bash(")), "no narrowing for an editing role");
});

test("carries a role's mcp and web capabilities through, and adds nothing for a role with no shell", () => {
  const tools = allowedToolsFor("claude", ["read", "web", "mcp:tracker"]);
  assert.ok(tools.includes("mcp__tracker"));
  assert.ok(tools.includes("WebFetch"));
  assert.ok(!tools.some((t) => t.startsWith("Bash")), "no shell capability, no shell tools");
});

// ---------------------------------------------------------------------------
// Per-tool invocation is the only tool-specific part. A new tool is an entry
// in RUNNERS, never a change to a role.
// ---------------------------------------------------------------------------
test("builds a headless claude command that selects the role", () => {
  const built = buildArgv({ tool: "claude", role: "code-reviewer", prompt: "review #33", tools: ["Read"] });
  assert.equal(built.ok, true);
  assert.equal(built.bin, "claude");
  assert.deepEqual(built.argv, ["-p", "--agent", "code-reviewer", "--allowedTools", "Read", "--", "review #33"]);
  // The prompt sits after `--` so a prompt beginning with a dash is not read
  // as a flag.
  assert.equal(built.argv.at(-2), "--");
});

test("refuses a tool it has no runner for, and says which it has", () => {
  const built = buildArgv({ tool: "gemini", role: "code-reviewer", prompt: "x", tools: [] });
  assert.equal(built.ok, false);
  assert.match(built.error, /no runner for tool "gemini"/);
  assert.match(built.error, /claude/);
});

test("parses the arguments it documents", () => {
  const args = parseArgs(["--role", "qa-engineer", "--prompt", "p", "--tool", "claude", "--dry-run"]);
  assert.deepEqual(
    { role: args.role, prompt: args.prompt, tool: args.tool, dryRun: args.dryRun },
    { role: "qa-engineer", prompt: "p", tool: "claude", dryRun: true },
  );
  assert.match(parseArgs(["--wat"]).error, /unexpected argument "--wat"/);
});

// ---------------------------------------------------------------------------
// Trust. An untrusted workspace has .claude/settings.json ignored, which is
// where the role guard hooks live - so the role arrives without its fence.
// ---------------------------------------------------------------------------
function fakeHome(projects) {
  const home = mkdtempSync(join(tmpdir(), "agent-run-"));
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ projects }));
  return home;
}

test("reads whether a workspace is trusted, and treats unknown as untrusted", () => {
  const root = "C:\\repo\\nostavel";
  assert.equal(claudeWorkspaceTrusted(root, fakeHome({ "c:/repo/nostavel": { hasTrustDialogAccepted: true } })), true);
  assert.equal(claudeWorkspaceTrusted(root, fakeHome({ "c:/repo/nostavel": { hasTrustDialogAccepted: false } })), false);
  assert.equal(claudeWorkspaceTrusted(root, fakeHome({ "c:/repo/other": { hasTrustDialogAccepted: true } })), false,
    "a workspace never opened is not trusted");
  // Unreadable config is "cannot tell", never "trusted" - guessing trusted is
  // the one answer that silently drops the guard.
  assert.equal(claudeWorkspaceTrusted(root, join(tmpdir(), "definitely-not-a-home-" + Date.now())), null);
  assert.equal(claudeWorkspaceTrusted(root, ""), null);
});

test("refuses to run an editing role in an untrusted workspace, and explains why", () => {
  const untrusted = { ok: false };
  const result = RUNNERS.claude.preflight({
    root: join(tmpdir(), "not-a-trusted-repo-" + Date.now()),
    capabilities: ["read", "edit", "shell"],
  });
  assert.equal(result.ok, untrusted.ok);
  assert.match(result.error, /not trusted/);
  assert.match(result.error, /owns/, "it should say what protection is missing");
  assert.match(result.error, /trust dialog/, "and how the owner fixes it");
});

test("lets a read-only role run in an untrusted workspace, but says so out loud", () => {
  const result = RUNNERS.claude.preflight({
    root: join(tmpdir(), "not-a-trusted-repo-" + Date.now()),
    capabilities: ["read", "shell"],
  });
  assert.equal(result.ok, true);
  assert.match(result.warning, /guard hook will not run/);
});

test("--read-only drops edit from a role that has it, so a review can run without the guard", () => {
  // security-architect owns docs/security/** but its review gate only reads.
  const caps = ["read", "web", "shell", "edit"];
  const tools = allowedToolsFor("claude", caps, { readOnly: true });
  assert.ok(!tools.includes("Edit"));
  assert.ok(!tools.includes("Write"));
  assert.ok(!tools.includes("Bash"), "and the shell narrows with it");
  assert.ok(tools.includes("Bash(gh pr diff:*)"));
  assert.ok(tools.includes("WebFetch"), "other capabilities are untouched");

  // Without the flag the same role keeps what its charter grants.
  assert.ok(allowedToolsFor("claude", caps).includes("Write"));
});

test("a role narrowed to read-only is allowed in an untrusted workspace", () => {
  const root = join(tmpdir(), "not-a-trusted-repo-" + Date.now());
  assert.equal(RUNNERS.claude.preflight({ root, capabilities: ["read", "web", "shell", "edit"] }).ok, false);
  const narrowed = RUNNERS.claude.preflight({ root, capabilities: ["read", "web", "shell"] });
  assert.equal(narrowed.ok, true);
  assert.match(narrowed.warning, /guard hook will not run/);
});

test("--read-only is parsed", () => {
  assert.equal(parseArgs(["--role", "x", "--prompt", "p", "--read-only"]).readOnly, true);
  assert.equal(parseArgs(["--role", "x", "--prompt", "p"]).readOnly, undefined);
});
