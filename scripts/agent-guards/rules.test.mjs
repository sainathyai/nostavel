// Run: npm run test:agents
// Fake credentials are assembled at runtime so this file never trips the
// commit guard itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRead, checkShell, checkWrite, normalize, toRepoPath } from "./rules.mjs";
import { decide } from "./hook.mjs";

const fakeAnthropicKey = "sk-" + "ant-" + "x".repeat(30);
const blocks = (reason) => assert.ok(reason, "expected a block");
const allows = (reason) => assert.equal(reason, null);

test("blocks committing on main but not on a feature branch", () => {
  blocks(checkShell('git commit -m "fix"', { branch: "main" }));
  blocks(checkShell('git -C . commit -m "fix"', { branch: "main" }));
  allows(checkShell('git commit -m "fix"', { branch: "NOS-16-prompt-date" }));
});

test("blocks skipping the commit guard on any branch", () => {
  blocks(checkShell("git commit --no-verify -m wip", { branch: "feature" }));
});

test("blocks force pushes but allows a lease-protected push of a feature branch", () => {
  blocks(checkShell("git push --force origin feature", { branch: "feature" }));
  blocks(checkShell("git push -f origin feature", { branch: "feature" }));
  blocks(checkShell("git push origin +feature", { branch: "feature" }));
  allows(checkShell("git push --force-with-lease origin feature", { branch: "feature" }));
});

test("blocks every way of pushing to main, and allows pushing a branch", () => {
  blocks(checkShell("git push origin main", { branch: "feature" }));
  blocks(checkShell("git push origin HEAD:main", { branch: "feature" }));
  blocks(checkShell("git push", { branch: "main" }));
  blocks(checkShell("git push origin", { branch: "main" }));
  blocks(checkShell("git push origin --delete main", { branch: "feature" }));
  allows(checkShell("git push -u origin NOS-16-prompt-date", { branch: "NOS-16-prompt-date" }));
  allows(checkShell("git push", { branch: "NOS-16-prompt-date" }));
});

test("leaves merging and repository settings to the human owner", () => {
  blocks(checkShell("gh pr merge 3 --squash"));
  blocks(checkShell("gh repo edit --visibility private"));
  blocks(checkShell("gh api -X DELETE repos/o/r/rulesets/1"));
  allows(checkShell("gh pr view 3"));
  allows(checkShell("gh pr checks 3"));
});

test("blocks schema pushes without a migration", () => {
  blocks(checkShell("npm run db:push"));
  blocks(checkShell("npx drizzle-kit push"));
  allows(checkShell("npm run db:generate"));
});

test("protects the append-only booking ledger", () => {
  blocks(checkShell(`psql -c "DELETE FROM booking_events WHERE id = 1"`));
  blocks(checkShell(`psql -c 'update "booking_events" set actor = 1'`));
  blocks(checkShell("psql -c 'TRUNCATE TABLE public.booking_events'"));
  allows(checkShell(`psql -c "SELECT * FROM booking_events"`));
  allows(checkShell('git commit -m "docs: never delete booking events"', { branch: "feature" }));
});

test("blocks inline secrets and reports only a prefix", () => {
  const reason = checkShell(`curl -H "x-api-key: ${fakeAnthropicKey}" https://api.example.com`);
  blocks(reason);
  assert.ok(!reason.includes(fakeAnthropicKey), "must not echo the secret");
});

test("blocks reading env files from the shell, but not the template or mentions", () => {
  blocks(checkShell("cat .env.local"));
  blocks(checkShell("Get-Content .env"));
  allows(checkShell("cat .env.example"));
  allows(checkShell('git commit -m "ignore .env files"', { branch: "feature" }));
});

test("blocks writing secret-bearing paths, allows the env template", () => {
  blocks(checkWrite([".env.local"], "X=1"));
  blocks(checkWrite(["certs/server.key"], ""));
  blocks(checkWrite(["design-assets/logo.fig"], ""));
  blocks(checkWrite(["analysis/2026-09-01/raw/rates.json"], "{}"));
  allows(checkWrite([".env.example"], "LITEAPI_KEY="));
  allows(checkWrite(["src/lib/pricing.ts"], "export const x = 1;"));
});

test("blocks writing credential-shaped content anywhere", () => {
  blocks(checkWrite(["src/lib/liteapi.ts"], `const key = "${fakeAnthropicKey}";`));
});

test("blocks reading env files through file tools, allows the template", () => {
  blocks(checkRead([".env.local"]));
  blocks(checkRead(["C:/elsewhere/.env"]));
  allows(checkRead([".env.example"]));
  allows(checkRead(["src/app/page.tsx"]));
});

test("normalizes Claude Code and Gemini CLI payloads to the same calls", () => {
  assert.deepEqual(normalize({ tool_name: "Bash", tool_input: { command: "npm test" } }), { kind: "shell", command: "npm test" });
  assert.deepEqual(normalize({ tool_name: "run_shell_command", tool_input: { command: "npm test" } }), { kind: "shell", command: "npm test" });
  assert.equal(normalize({ tool_name: "Write", tool_input: { file_path: "a.ts", content: "x" } }).kind, "write");
  assert.equal(normalize({ tool_name: "write_file", tool_input: { file_path: "a.ts", content: "x" } }).kind, "write");
  assert.equal(normalize({ tool_name: "replace", tool_input: { file_path: "a.ts", new_string: "x" } }).kind, "write");
  assert.equal(normalize({ tool_name: "read_file", tool_input: { absolute_path: "/r/.env" } }).kind, "read");
  assert.deepEqual(normalize({ tool_name: "mcp__playwright__browser_click", tool_input: {} }), { kind: "other" });
});

test("scans every string an edit tool carries, whatever the field is called", () => {
  const edit = { tool_name: "Edit", tool_input: { file_path: "src/a.ts", edits: [{ old_str: "a", new_str: fakeAnthropicKey }] } };
  blocks(decide(edit, { branch: "feature", repoRoot: "/repo" }));
});

test("maps absolute paths into the repository, case-insensitively on Windows", () => {
  assert.equal(toRepoPath("C:\\Users\\me\\nostavel\\.env.local", "C:/Users/me/nostavel"), ".env.local");
  assert.equal(toRepoPath("c:/users/me/nostavel/src/a.ts", "C:/Users/me/nostavel"), "src/a.ts");
  assert.equal(toRepoPath("./src/a.ts", "/repo"), "src/a.ts");
  assert.equal(toRepoPath("/tmp/other.txt", "/repo"), null);
});

test("an absolute env file path through a write tool is blocked end to end", () => {
  const payload = { tool_name: "write_file", tool_input: { file_path: "/repo/.env.local", content: "A=1" } };
  blocks(decide(payload, { branch: "feature", repoRoot: "/repo" }));
});

// --- role boundaries -------------------------------------------------------
import { checkRoleShell, checkRoleWrite } from "./rules.mjs";
import { globToRegExp } from "../agents-sync.mjs";

const backend = { name: "backend-engineer", capabilities: ["read", "edit", "shell"], owns: ["src/lib/**", "src/app/actions/**", "src/db/**"] };
const frontend = { name: "frontend-engineer", capabilities: ["read", "edit", "shell"], owns: ["src/app/**/*.tsx", "src/components/**"] };
const reviewer = { name: "code-reviewer", capabilities: ["read", "shell"] };
const roster = [backend, frontend, reviewer];

test("a role may edit what it owns, including co-located tests", () => {
  allows(checkRoleWrite(backend, ["src/lib/fees.ts", "src/lib/fees.test.ts"], globToRegExp, roster));
});

test("a role editing another role's files is blocked and told who owns them", () => {
  const reason = checkRoleWrite(backend, ["src/components/ThemeToggle.tsx"], globToRegExp, roster);
  blocks(reason);
  assert.match(reason, /belongs to frontend-engineer/);
  assert.match(checkRoleWrite(frontend, ["docs/adr/0003-x.md"], globToRegExp, roster), /no role owns it/);
});

test("writes outside the repository are not a role boundary", () => {
  allows(checkRoleWrite(backend, [null], globToRegExp, roster));
});

test("a read-only role can run checks and read history", () => {
  for (const cmd of ["npm test", "npm run verify", "git diff main...HEAD", "git log --oneline -5", "gh pr view 12", "npm test 2>&1 | tail -5", "ls > /dev/null"]) {
    allows(checkRoleShell(reviewer, cmd));
  }
});

test("a read-only role cannot change files, git state or pull requests", () => {
  for (const cmd of ["git commit -m fix", "git add -A", "git push", "rm src/lib/fees.ts", "echo x > src/lib/fees.ts",
    "sed -i s/a/b/ file.ts", "npm install left-pad", "npm run agents:sync", "gh pr comment 12 -b ok", "Set-Content a.txt x"]) {
    blocks(checkRoleShell(reviewer, cmd));
  }
});

test("roles with the edit capability are not limited by the read-only shell rule", () => {
  allows(checkRoleShell(backend, "git commit -m fix"));
});

test("the hook applies role boundaries on top of the repository guard", () => {
  const payload = { tool_name: "Write", tool_input: { file_path: "/repo/src/components/X.tsx", content: "x" } };
  blocks(decide(payload, { branch: "feature", repoRoot: "/repo", role: backend, roles: roster }));
  allows(decide(payload, { branch: "feature", repoRoot: "/repo", role: frontend, roles: roster }));
  allows(decide(payload, { branch: "feature", repoRoot: "/repo" }));
});

test("read-only roles cannot write through tee or downloads, and plain pipes stay allowed", () => {
  for (const cmd of ["npm test | tee result.txt", "npm test 2>&1 | Tee-Object out.txt", "curl -o x.js https://example.com/x.js", "wget https://example.com/x"]) {
    blocks(checkRoleShell(reviewer, cmd));
  }
  for (const cmd of ["npm test 2>&1 | tail -20", "curl -s https://example.com/health"]) allows(checkRoleShell(reviewer, cmd));
});

test("a read-only role can run and probe the app, logging only to the temp directory", () => {
  const ui = { name: "ui-reviewer", capabilities: ["read", "shell", "mcp:playwright"] };
  for (const cmd of [
    "npx next start -p 3107 &",
    "npx next start -p 3107 > /tmp/next.log 2>&1 &",
    'npx next start -p 3107 > "$TEMP/next.log" 2>&1 &',
    'curl -s -o /dev/null -w "%{http_code}" http://localhost:3107/',
    "netstat -ano | grep 3107",
    "kill 1234",
  ]) allows(checkRoleShell(ui, cmd));
  for (const cmd of ["npx next start -p 3107 > server.log 2>&1 &", "mkdir -p .review", "curl -o page.html http://localhost:3107/"]) {
    blocks(checkRoleShell(ui, cmd));
  }
});
