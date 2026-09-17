#!/usr/bin/env node
// Commit guard. Blocks what must never reach this public repository:
//   - env files (only .env.example is allowed)
//   - analysis outputs, which can carry supplier net pricing (analysis/README.md)
//   - design source files
//   - files over MAX_BYTES
//   - anything shaped like a credential
//
// It reads STAGED content (the index), not the working tree, so it checks exactly
// what the commit will contain.
//
//   node scripts/git-guard.mjs            check staged files (the pre-commit hook)
//   node scripts/git-guard.mjs --all      check every tracked file (CI, audits)
//   node scripts/git-guard.mjs --install  point git at .githooks/ (npm "prepare")
//
// Do not bypass with --no-verify. CI runs this guard over every tracked file as a
// second line of defence, but a secret that reaches a pushed commit has to be
// rotated, not just removed.
//
// The path and secret rules live in scripts/agent-guards/patterns.mjs, shared
// with the agent tool guard, so both enforce the same list.
import { execFileSync } from "node:child_process";
import { findSecrets, pathViolation } from "./agent-guards/patterns.mjs";

const git = (args) => execFileSync("git", args, { maxBuffer: 256 * 1024 * 1024 });

if (process.argv.includes("--install")) {
  try {
    git(["rev-parse", "--is-inside-work-tree"]);
    git(["config", "core.hooksPath", ".githooks"]);
  } catch {
    // Not a git checkout (tarball install, Docker build): nothing to install.
  }
  process.exit(0);
}

// Largest tracked file today is src/data/intl-cities.json at 1.2 MB (2026-09-15).
const MAX_BYTES = 2 * 1024 * 1024;

const all = process.argv.includes("--all");
const files = git(all ? ["ls-files", "-z"] : ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"])
  .toString("utf8")
  .split("\0")
  .filter(Boolean);

const problems = [];
for (const path of files) {
  const why = pathViolation(path);
  if (why) {
    problems.push(`${path}: ${why}`);
    continue;
  }
  const size = Number(git(["cat-file", "-s", `:${path}`]).toString().trim());
  if (size > MAX_BYTES) {
    problems.push(`${path}: ${(size / 1048576).toFixed(1)} MB is over the ${MAX_BYTES / 1048576} MB limit`);
    continue;
  }
  const buf = git(["show", `:${path}`]);
  if (buf.subarray(0, 8000).includes(0)) continue; // binary
  for (const { label, prefix, line } of findSecrets(buf.toString("utf8"))) {
    // Show only a prefix: the guard must not print the secret it caught.
    problems.push(`${path}:${line}: possible ${label} (${prefix}...)`);
  }
}

if (problems.length > 0) {
  console.error(`\ngit-guard: blocked (${problems.length} problem${problems.length === 1 ? "" : "s"})\n`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error("\nThis repository is public. See analysis/README.md and SECURITY.md.");
  console.error("Unstage the file (git restore --staged <path>) or move the value into .env.local.\n");
  process.exit(1);
}
if (all) console.log(`git-guard: ${files.length} tracked files clean`);
