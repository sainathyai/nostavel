#!/usr/bin/env node
// Aggregates the result of every job the `checks` job in ci.yml `needs:`, and
// decides pass/fail. This exists because a bare `needs:` list does not catch a
// needed job that was skipped or cancelled - GitHub only blocks the dependent job
// when a dependency *fails*, and the `checks` job runs `if: always()` so branch
// protection (which requires a status check named exactly "checks") always gets a
// result to look at. Without this script, a job silently skipped (a workflow typo,
// a bad `if:` condition) would leave `checks` green.
//
//   node scripts/ci-checks-result.mjs   reads NEEDS_JSON and GITHUB_EVENT_NAME
//                                         from the environment (ci.yml sets
//                                         NEEDS_JSON: ${{ toJSON(needs) }};
//                                         GITHUB_EVENT_NAME is set by GitHub
//                                         Actions on every run)
import { pathToFileURL } from "node:url";

/**
 * Renders a job's `result` for a failure message, distinguishing the ways it can
 * be wrong: absent entirely, explicitly `null`, some non-string GitHub shape, or
 * a string that just isn't "success" (an unknown value like "neutral" or
 * "startup_failure" included - this is an allow-list, so a future result string
 * GitHub adds is a failure here until this script is taught about it, not a
 * silent pass).
 * @param {unknown} result
 * @returns {string}
 */
function describeResult(result) {
  if (result === undefined) return "<missing>";
  if (result === null) return "null";
  if (typeof result !== "string") return `<non-string: ${JSON.stringify(result)}>`;
  return result;
}

/**
 * @param {Record<string, {result: string}>} needs the `needs` context, one entry
 *   per job named in `checks`'s `needs:` list
 * @param {string} eventName the triggering event, e.g. "pull_request" or "push"
 * @returns {{ok: true, message: string} | {ok: false, message: string}}
 */
export function evaluateChecks(needs, eventName) {
  // An empty or absent needs-context is the failure mode this script exists to
  // close, one level up: a dropped `env:` mapping, a typo in NEEDS_JSON, or a
  // future edit that trims the checks job's needs: list must all fail loudly
  // here, not report "0 jobs passed" as green having verified nothing.
  if (!needs || typeof needs !== "object" || Array.isArray(needs) || Object.keys(needs).length === 0) {
    return {
      ok: false,
      message: "checks: failing - the needs-context is empty or missing, so nothing was verified. " +
        "Check that the checks job in ci.yml still sets env: NEEDS_JSON: ${{ toJSON(needs) }} and that " +
        "its needs: list is not empty.",
    };
  }
  // GitHub Actions always sets GITHUB_EVENT_NAME on every run. Reading an absent
  // or empty value as "not a pull_request event" would silently forgive pr-title
  // being skipped on an actual pull_request run - the exact regression the
  // exemption below exists to catch - so this fails closed instead.
  if (typeof eventName !== "string" || eventName === "") {
    return {
      ok: false,
      message: "checks: failing - GITHUB_EVENT_NAME is not set. GitHub Actions always sets this " +
        "environment variable on every run, so its absence means the workflow or this script is " +
        "misconfigured, not that this run is on some other event.",
    };
  }
  const problems = [];
  for (const [name, job] of Object.entries(needs)) {
    const result = job?.result;
    // Allow-list: the exact string "success" is the only passing value. Anything
    // else - failure, cancelled, skipped, a missing key, null, a non-string, or
    // an unknown status GitHub might add later - is a failure, named below.
    if (result === "success") continue;
    // The one intentional skip: pr-title's own `if:` scopes it to pull_request
    // events, so it legitimately does not run on a push to main. Every other
    // non-success result - including pr-title skipped ON a pull_request event,
    // which is the check silently not running - is a failure.
    const exempt = name === "pr-title" && result === "skipped" && eventName !== "pull_request";
    if (exempt) continue;
    problems.push(`${name}: ${describeResult(result)}`);
  }
  if (problems.length) {
    return { ok: false, message: `checks: failing - ${problems.join(", ")}` };
  }
  return { ok: true, message: `checks: all ${Object.keys(needs).length} needed job(s) passed` };
}

/**
 * Parses the NEEDS_JSON env value. Never throws: a missing or malformed value is
 * a checked failure reported the same way as any other reason this script fails,
 * not an unhandled SyntaxError with a bare stack trace.
 * @param {string | undefined} raw
 * @returns {{ok: true, needs: unknown} | {ok: false, message: string}}
 */
export function parseNeedsEnv(raw) {
  if (raw === undefined || raw === "") {
    return {
      ok: false,
      message: "ci-checks-result: NEEDS_JSON is not set. The checks job in ci.yml must set " +
        "env: NEEDS_JSON: ${{ toJSON(needs) }}.",
    };
  }
  try {
    return { ok: true, needs: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, message: `ci-checks-result: NEEDS_JSON is not valid JSON (${err.message}).` };
  }
}

function main() {
  const parsed = parseNeedsEnv(process.env.NEEDS_JSON);
  if (!parsed.ok) {
    console.error(parsed.message);
    process.exit(1);
  }
  const eventName = process.env.GITHUB_EVENT_NAME ?? "";
  const result = evaluateChecks(parsed.needs, eventName);
  console.log(result.message);
  if (!result.ok) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
