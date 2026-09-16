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
// Do not bypass with --no-verify. CI runs gitleaks as a second line of defence,
// but a secret that reaches a pushed commit has to be rotated, not just removed.
import { execFileSync } from "node:child_process";

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

export function pathViolation(path) {
  const base = path.split("/").pop() ?? "";
  if (base.startsWith(".env") && base !== ".env.example") {
    return "env file (only .env.example may be committed)";
  }
  if (/^analysis\/(.*\/)?raw\//.test(path)) return "analysis output (raw API responses)";
  if (/^analysis\/.*\.(csv|json)$/.test(path)) return "analysis output (CSV/JSON results)";
  if (/^analysis\/(.*\/)?dashboard\.html$/.test(path)) return "generated analysis dashboard";
  if (/^analysis\/(.*\/)?_[^/]*_out[^/]*\.txt$/.test(path)) return "captured analysis output";
  if (path === "analysis/pricing-observations.md") return "raw supplier pricing notes";
  if (path.startsWith("design-assets/")) return "design source file (export the asset into public/)";
  if (/\.(pem|key|p12|pfx)$/i.test(path)) return "private key or certificate";
  return null;
}

const SECRET_PATTERNS = [
  ["LiteAPI key", /\b(?:sand|prod)_[A-Za-z0-9-]{20,}/],
  ["Anthropic API key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["Resend API key", /\bre_[A-Za-z0-9]{6,}_[A-Za-z0-9]{16,}/],
  ["Google OAuth client secret", /GOCSPX-[A-Za-z0-9_-]{20,}/],
  ["Neon database password", /\bnpg_[A-Za-z0-9]{12,}/],
  ["database URL with a password", /postgres(?:ql)?:\/\/[^\s:@/'"`]+:[^\s@/'"`]+@/],
  ["Stripe secret key", /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/],
  ["webhook signing secret", /\bwhsec_[A-Za-z0-9]{20,}/],
  ["GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/],
  ["AWS access key id", /\bAKIA[0-9A-Z]{16}\b/],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

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
  const text = buf.toString("utf8");
  for (const [label, re] of SECRET_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      const line = text.slice(0, m.index).split("\n").length;
      // Show only a prefix: the guard must not print the secret it caught.
      problems.push(`${path}:${line}: possible ${label} (${m[0].slice(0, 6)}...)`);
    }
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
