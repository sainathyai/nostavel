// What must never reach this public repository, or be touched by an agent.
// One list, shared by the git pre-commit guard (scripts/git-guard.mjs) and the
// agent tool guard (scripts/agent-guards/hook.mjs), so a rule added for one is
// enforced by both. Pure: no fs, no git, no process.

/** Env files hold real secrets; only the documented template is shareable. */
export function isEnvFile(path) {
  const base = path.split("/").pop() ?? "";
  return base.startsWith(".env") && base !== ".env.example";
}

/** Why a repo-relative path may not be committed, or null if it may. */
export function pathViolation(path) {
  if (isEnvFile(path)) return "env file (only .env.example may be committed)";
  if (/^analysis\/(.*\/)?raw\//.test(path)) return "analysis output (raw API responses)";
  if (/^analysis\/.*\.(csv|json)$/.test(path)) return "analysis output (CSV/JSON results)";
  if (/^analysis\/(.*\/)?dashboard\.html$/.test(path)) return "generated analysis dashboard";
  if (/^analysis\/(.*\/)?_[^/]*_out[^/]*\.txt$/.test(path)) return "captured analysis output";
  if (path === "analysis/pricing-observations.md") return "raw supplier pricing notes";
  if (path.startsWith("design-assets/")) return "design source file (export the asset into public/)";
  if (/\.(pem|key|p12|pfx)$/i.test(path)) return "private key or certificate";
  return null;
}

export const SECRET_PATTERNS = [
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

/**
 * Credential-shaped strings in `text`. Each hit carries only a 6-character
 * prefix: a guard must never print the secret it caught.
 */
export function findSecrets(text) {
  const hits = [];
  for (const [label, re] of SECRET_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      hits.push({ label, prefix: m[0].slice(0, 6), line: text.slice(0, m.index).split("\n").length });
    }
  }
  return hits;
}
