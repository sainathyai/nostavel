// Provider-neutral guard rules for coding agents. Pure: no fs, git or process.
//
// Every agent tool (Claude Code, Gemini CLI, Codex, Copilot, ...) calls
// hook.mjs, which normalizes that tool's hook payload into one of three shapes
// and asks these functions. Each returns a human-readable reason to block, or
// null to allow. Reasons say what to do instead, because the agent reads them.
import { findSecrets, isEnvFile } from "./patterns.mjs";

// Tool names seen in hook payloads, per tool. Unknown tools are allowed through:
// git hooks and CI remain the backstop for anything a tool calls differently.
const SHELL_TOOLS = new Set(["Bash", "PowerShell", "run_shell_command", "shell", "local_shell", "exec_command"]);
const WRITE_TOOLS = new Set([
  "Write", "Edit", "MultiEdit", "NotebookEdit",
  "write_file", "replace", "edit_file", "create_file", "apply_patch",
]);
const READ_TOOLS = new Set(["Read", "read_file", "read_many_files", "view"]);
const PATH_KEYS = new Set(["file_path", "path", "absolute_path", "notebook_path", "filePath", "paths"]);

function strings(value, skipKeys, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, skipKeys, out);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) if (!skipKeys.has(k)) strings(v, skipKeys, out);
  }
  return out;
}

function pathsOf(input) {
  const out = [];
  for (const key of PATH_KEYS) {
    const v = input?.[key];
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) out.push(...v.filter((p) => typeof p === "string"));
  }
  return out;
}

/**
 * Normalize a hook payload from any supported tool.
 * @returns {{kind: "shell", command: string} | {kind: "write", paths: string[], content: string}
 *          | {kind: "read", paths: string[]} | {kind: "other"}}
 */
export function normalize(payload) {
  const tool = payload?.tool_name ?? payload?.toolName ?? "";
  const input = payload?.tool_input ?? payload?.toolInput ?? payload?.tool_args ?? {};
  if (SHELL_TOOLS.has(tool)) {
    const command = typeof input.command === "string" ? input.command
      : Array.isArray(input.command) ? input.command.join(" ") : "";
    return { kind: "shell", command };
  }
  if (WRITE_TOOLS.has(tool)) {
    return { kind: "write", paths: pathsOf(input), content: strings(input, PATH_KEYS).join("\n") };
  }
  if (READ_TOOLS.has(tool)) return { kind: "read", paths: pathsOf(input) };
  return { kind: "other" };
}

/** Repo-relative, forward-slash path, or null when outside the repo. */
export function toRepoPath(path, repoRoot) {
  const norm = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  let p = norm(path);
  const root = norm(repoRoot ?? "");
  const isAbs = /^([A-Za-z]:\/|\/)/.test(p);
  if (!isAbs) return p.replace(/^\.\//, "");
  if (root && p.toLowerCase().startsWith(root.toLowerCase() + "/")) return p.slice(root.length + 1);
  return null;
}

const GIT = String.raw`\bgit\b(?:\s+-[Cc]\s+\S+)*`;
const SEGMENT = String.raw`[^;&|\n]*`;

/** @param {{branch?: string}} ctx current git branch of the working directory */
export function checkShell(command, ctx = {}) {
  const cmd = command ?? "";
  const onMain = ctx.branch === "main";

  const secrets = findSecrets(cmd);
  if (secrets.length) {
    return `command contains a possible ${secrets[0].label} (${secrets[0].prefix}...). ` +
      "Read secrets from the environment (.env.local), never inline them.";
  }
  if (new RegExp(`${GIT}\\s+commit\\b${SEGMENT}\\s--no-verify\\b`).test(cmd)) {
    return "git commit --no-verify skips the repository guard. Fix what the guard reports instead.";
  }
  if (onMain && new RegExp(`${GIT}\\s+commit\\b`).test(cmd)) {
    return "committing on main is not allowed. Create a branch first: git switch -c NOS-<n>-short-slug";
  }
  const push = new RegExp(`${GIT}\\s+push\\b(${SEGMENT})`).exec(cmd);
  if (push) {
    const args = push[1];
    if (/\s(--force(?!-with-lease)|-f)\b|\s\+\S/.test(args)) {
      return "force push is not allowed. Use --force-with-lease on your own feature branch, never on main.";
    }
    const positional = args.trim().split(/\s+/).filter((t) => t && !t.startsWith("-"));
    if (/\s--delete\b/.test(args) && positional.includes("main")) {
      return "deleting main is not allowed.";
    }
    // `git push origin main`, `git push origin HEAD:main`, or a bare
    // `git push [remote]` while main is checked out.
    const targetsMain = positional.slice(1).some((ref) => ref === "main" || /:main$/.test(ref));
    if (targetsMain || (onMain && positional.length <= 1)) {
      return "pushing to main is not allowed. Push your branch and open a pull request.";
    }
  }
  if (/\bgh\s+pr\s+merge\b/.test(cmd)) {
    return "agents do not merge pull requests. Leave the PR for the human owner to review and merge.";
  }
  if (/\bgh\s+repo\s+(delete|edit|rename)\b/.test(cmd) || /\bgh\s+api\b[^\n]*-X\s*DELETE\b/i.test(cmd)) {
    return "changing or deleting repository settings is a human action.";
  }
  if (/\bnpm\s+run\s+db:push\b|\bdrizzle-kit\s+push\b/.test(cmd)) {
    return "db:push applies schema changes without a migration. Use npm run db:generate and commit the migration.";
  }
  if (/\b(delete\s+from|update|truncate(\s+table)?)\s+("?public"?\.)?"?booking_events\b/i.test(cmd)) {
    return "booking_events is an append-only ledger. Never update or delete its rows; append a correcting event.";
  }
  if (/\b(cat|type|less|more|head|tail|bat|source|Get-Content|gc|grep|rg|sed|awk)\b[^|;&\n]*(^|[\s"'/\\])\.env(?!\.example)(\.[\w.-]+)?(?=$|[\s"'])/m.test(cmd)) {
    return "reading env files is not allowed; they hold real secrets. Use .env.example for variable names.";
  }
  return null;
}

/** @param {string[]} repoPaths repo-relative paths (null entries are outside the repo) */
export function checkWrite(repoPaths, content) {
  for (const p of repoPaths) {
    if (p == null) continue;
    if (isEnvFile(p)) return `${p}: env files hold real secrets and are edited by hand only. Document names in .env.example.`;
    if (/\.(pem|key|p12|pfx)$/i.test(p)) return `${p}: private keys and certificates never live in the repository.`;
    if (p.startsWith("design-assets/")) return `${p}: design source files stay out of the repo; export the asset into public/.`;
    if (/^analysis\/(.*\/)?raw\//.test(p)) return `${p}: raw supplier responses are produced by analysis scripts, never written by hand.`;
  }
  const secrets = findSecrets(content ?? "");
  if (secrets.length) {
    return `content contains a possible ${secrets[0].label} (${secrets[0].prefix}...). ` +
      "Reference the environment variable instead of the value.";
  }
  return null;
}

export function checkRead(repoPaths) {
  for (const p of repoPaths) {
    const base = (p ?? "").split("/").pop() ?? "";
    if (p != null && isEnvFile(base)) {
      return `${p}: env files hold real secrets and are not read by agents. Use .env.example for variable names.`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Role boundaries (docs/team/roles.md). A tool passes --role <name> when it runs
// a role; the role's neutral definition in .agents/roles supplies `owns` (globs
// it may edit) and `capabilities`. Matchers are passed in to keep this file pure.
// ---------------------------------------------------------------------------

/**
 * @param {{name: string, owns?: string[]}} role
 * @param {(string|null)[]} repoPaths repo-relative paths (null = outside the repo, not ours to police)
 * @param {(glob: string) => RegExp} toRegExp
 * @param {Array<{name: string, owns?: string[]}>} [allRoles] to name the owner in the message
 */
export function checkRoleWrite(role, repoPaths, toRegExp, allRoles = []) {
  const owns = (role.owns ?? []).map(toRegExp);
  for (const p of repoPaths) {
    if (p == null) continue;
    if (owns.some((re) => re.test(p))) continue;
    const owner = allRoles.find((r) => r.name !== role.name && (r.owns ?? []).some((g) => toRegExp(g).test(p)));
    const who = owner ? `it belongs to ${owner.name}` : "no role owns it";
    return `${p} is outside what ${role.name} may edit (${who}). Hand it off through the ticket or pull request instead of editing it.`;
  }
  return null;
}

const MUTATING_SHELL = [
  /\bgit\b(?:\s+-[Cc]\s+\S+)*\s+(add|commit|push|reset|restore|rm|mv|merge|rebase|stash|tag|cherry-pick|revert|switch\s+-c|checkout\s+-b|checkout\s+--|apply|am)\b/,
  /(^|[\s;&|(])(rm|rmdir|mv|cp|mkdir|touch|del|tee|dd|Remove-Item|Move-Item|Copy-Item|New-Item|Set-Content|Add-Content|Out-File|Tee-Object)\b/,
  // Downloads written to disk.
  /\bcurl\b[^|;&\n]*\s(-o|--output|-O|--remote-name)\b|\bwget\b/,
  /\bsed\s+(-\w*\s+)*-i\b/,
  /\bnpm\s+(install|i|ci|uninstall|update|add)\b|\bnpm\s+run\s+(db:migrate|db:generate|agents:sync|vendored:fix)\b|\bdrizzle-kit\s+(migrate|generate|push)\b/,
  /\bgh\s+(pr|issue)\s+(create|edit|close|comment|review)\b/,
  // Redirecting output into a file (but not 2>&1 or into the null device).
  /(^|[^\d&<>])>{1,2}\s*(?!&|\/dev\/null\b|\$null\b|nul\b)[^\s|;&]/i,
];

/**
 * A role without the edit capability may run checks, never change anything.
 * This is a deny-list, so it is defence in depth, not a sandbox: an interpreter
 * one-liner can still write a file. Git hooks, CI and review remain the backstop.
 */
export function checkRoleShell(role, command) {
  if ((role.capabilities ?? []).includes("edit")) return null;
  const cmd = command ?? "";
  if (MUTATING_SHELL.some((re) => re.test(cmd))) {
    return `${role.name} is a read-only role: it may run checks and read history, not change files, git state or pull requests. Report the finding and hand it off.`;
  }
  return null;
}
