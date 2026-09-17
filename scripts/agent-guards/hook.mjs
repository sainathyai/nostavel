#!/usr/bin/env node
// Agent tool guard: one entry point for every coding-agent tool's pre-tool hook.
//
// Reads the tool's hook payload (JSON) on stdin, normalizes it (rules.mjs), and
// exits 2 with the reason on stderr to block. Exit 2 + stderr is the blocking
// contract shared by Claude Code (PreToolUse) and Gemini CLI (BeforeTool); a new
// tool is wired up by pointing its hook config here (see .agents/README.md).
//
// Fails open (exit 0) on a malformed payload or an internal error: a broken
// guard must not stop all work, and the git pre-commit guard plus CI still
// enforce the repository rules for anything that slips through.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { checkRead, checkShell, checkWrite, normalize, toRepoPath } from "./rules.mjs";

function git(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).toString().trim();
  } catch {
    return undefined;
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

export function decide(payload, { branch, repoRoot }) {
  const call = normalize(payload);
  if (call.kind === "shell") return checkShell(call.command, { branch });
  if (call.kind === "write") return checkWrite(call.paths.map((p) => toRepoPath(p, repoRoot)), call.content);
  if (call.kind === "read") return checkRead(call.paths.map((p) => toRepoPath(p, repoRoot) ?? p.replace(/\\/g, "/")));
  return null;
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    process.exit(0);
  }
  const cwd = typeof payload?.cwd === "string" ? payload.cwd : process.cwd();
  const reason = decide(payload, {
    // Not `rev-parse --abbrev-ref HEAD`: that fails in a repository with no
    // commits yet, which would silently allow the first commit onto main.
    branch: git(["branch", "--show-current"], cwd),
    repoRoot: git(["rev-parse", "--show-toplevel"], cwd) ?? cwd,
  });
  if (reason) {
    process.stderr.write(`Blocked by repository guard: ${reason}\n`);
    process.exit(2);
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => process.exit(0));
}
