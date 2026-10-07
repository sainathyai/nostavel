#!/usr/bin/env node
// Is the copy that was just started worth sending visitors to?
//
// Run against a Cloud Run revision that is live but holds NO traffic, before
// traffic is moved to it. If this fails, the previous revision keeps serving and
// nobody ever sees the new one (NOS-61 acceptance criteria 5 and 6).
//
// WHAT IT REFUSES TO PROMOTE, AND WHY EACH ONE IS HERE:
//
//   - A copy that does not answer at all, or answers `ok: false`.
//   - A copy on a LIVE supplier key. The environment refuses every request in
//     that state by itself (src/proxy.ts), and this is the second layer the
//     NOS-60 review asked for: the thing that moves traffic should also refuse.
//   - A copy that is not the environment we think we are deploying. If a deploy
//     is ever pointed at the wrong service, "it answered healthily" is not
//     enough - it has to be the right copy answering.
//   - A copy that cannot reach its database. It would fail on the first page a
//     guest opened.
//   - A copy running a different commit than the one being deployed. That is how
//     a deploy that silently did nothing is caught: the health answer carries the
//     commit baked into the image (NOS-60), so this compares what is running
//     against what was asked for.
//
// The decision is `evaluateDeployHealth`, a pure function, because it is a money
// rule: "do not move traffic to a copy with a live supplier key" belongs
// somewhere a test can reach rather than inside a shell pipeline.
//
//   node scripts/deploy-smoke.mjs <base-url>
//     env: CRON_SECRET (for the deep probe), EXPECT_ENV, EXPECT_SHA
import { pathToFileURL } from "node:url";

/** How long to keep retrying a cold revision before calling it dead. */
export const READY_TIMEOUT_MS = 90_000;
export const RETRY_DELAY_MS = 3_000;

/**
 * @typedef {object} Expected
 * @property {string} env      the environment name this deploy is for, e.g. "uat"
 * @property {string} [sha]    the commit being deployed. Omitted ONLY by a
 *   deliberate `--any-commit` run; the pipeline always supplies it, because a
 *   check that silently stops checking when its input goes missing is the one
 *   kind this script must not have (NOS-61 security review).
 */

/**
 * @param {unknown} publicHealth  body of GET /api/health
 * @param {unknown} deepHealth    body of GET /api/health?deep=1
 * @param {Expected} expected
 * @returns {{ok: boolean, problems: string[]}}
 */
export function evaluateDeployHealth(publicHealth, deepHealth, expected) {
  const problems = [];

  if (!publicHealth || typeof publicHealth !== "object") {
    return { ok: false, problems: ["the health route did not return an object"] };
  }
  if (!deepHealth || typeof deepHealth !== "object") {
    return {
      ok: false,
      problems: [
        "the detailed health route did not return an object - check that CRON_SECRET matches the " +
          "value deployed to the environment",
      ],
    };
  }

  const pub = /** @type {Record<string, unknown>} */ (publicHealth);
  const deep = /** @type {Record<string, unknown>} */ (deepHealth);

  if (pub.ok !== true) problems.push("the copy reports itself unhealthy (ok is not true)");

  if (pub.env !== expected.env) {
    problems.push(
      `this copy says it is "${String(pub.env)}", but the deploy is for "${expected.env}". ` +
        "An unconfigured image reports itself as something else on purpose (NOS-60), and a copy " +
        "that does not know which environment it is must not take traffic.",
    );
  }

  // THE MONEY CHECK. Anything other than an explicit "sandbox" refuses: a
  // missing or unrecognised value is not evidence of safety.
  if (deep.supplier !== "sandbox") {
    problems.push(
      `the supplier key is "${String(deep.supplier)}", not "sandbox". Every deployed copy stays on ` +
        "the supplier sandbox and the live-money gate stays shut: refusing to move traffic.",
    );
  }

  if (deep.database !== "ok") {
    problems.push(
      `the database is "${String(deep.database)}". A copy that cannot reach its database would fail ` +
        "on the first page a guest opened.",
    );
  }

  // AN UNREADABLE ANSWER IS NOT A CLEAN ONE. This used to treat a missing or
  // non-array `problems` field as "no fatal configuration problems", which is
  // the same fail-open shape as an unchecked expiry (.agents/rules/security.md,
  // and NOS-9 where `Date.now() > undefined` read as "not expired"). Raised by
  // the NOS-61 security review. A copy that cannot tell us what is wrong with it
  // does not get traffic.
  if (!Array.isArray(deep.problems)) {
    problems.push(
      "the detailed health answer has no problems list, so this copy cannot say whether its " +
        "configuration is sound. Refusing to read that as 'nothing is wrong'.",
    );
  } else {
    const fatal = deep.problems.filter((p) => p && typeof p === "object" && p.severity === "fatal");
    for (const p of fatal) problems.push(`fatal configuration problem: ${String(p.code)}`);
  }

  if (expected.sha && pub.sha !== expected.sha) {
    problems.push(
      `this copy is running commit ${String(pub.sha)}, but ${expected.sha} was deployed. ` +
        "Either the deploy did not take effect, or traffic is being checked against the wrong revision.",
    );
  }

  // Reported even when nothing is fatal: "no email key" is invisible until a
  // guest does not get their confirmation.
  const warnings = Array.isArray(deep.problems)
    ? deep.problems.filter((p) => p && typeof p === "object" && p.severity === "warn")
    : [];

  return {
    ok: problems.length === 0,
    problems,
    ...(warnings.length ? { warnings: warnings.map((w) => String(w.code)) } : {}),
  };
}

/**
 * Fetch JSON, returning the parse failure rather than throwing it.
 *
 * A cold Cloud Run revision answers its first request slowly, and an unhealthy
 * one answers 503 with a perfectly good JSON body that this script needs to
 * read - so a non-2xx status is not by itself a reason to stop reading.
 *
 * @param {string} url
 * @param {Record<string, string>} headers
 * @returns {Promise<{status: number, body: unknown} | {error: string}>}
 */
export async function fetchJson(url, headers = {}) {
  try {
    const res = await fetch(url, { headers, cache: "no-store" });
    const text = await res.text();
    try {
      return { status: res.status, body: JSON.parse(text) };
    } catch {
      return { error: `${url} answered ${res.status} with a body that is not JSON: ${text.slice(0, 200)}` };
    }
  } catch (err) {
    return { error: `${url} could not be reached: ${err?.message ?? err}` };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for a revision to answer anything at all.
 *
 * Separate from the health decision: "has not finished starting" and "is broken"
 * are different answers, and only the second should fail a deploy.
 *
 * @param {string} base
 * @param {{now?: () => number, wait?: (ms: number) => Promise<void>}} [clock]
 */
export async function waitForAnswer(base, clock = {}) {
  const now = clock.now ?? Date.now;
  const wait = clock.wait ?? sleep;
  const deadline = now() + READY_TIMEOUT_MS;

  for (;;) {
    const res = await fetchJson(`${base}/api/health`);
    if (!("error" in res)) return res;
    if (now() >= deadline) return res;
    await wait(RETRY_DELAY_MS);
  }
}

async function main() {
  const base = process.argv[2]?.replace(/\/+$/, "");
  if (!base) {
    console.error("deploy-smoke: usage: node scripts/deploy-smoke.mjs <base-url>");
    process.exit(1);
  }
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("deploy-smoke: CRON_SECRET is not set, so the detailed health check cannot be made.");
    process.exit(1);
  }
  // EXPECT_SHA IS REQUIRED UNLESS WAIVED OUT LOUD. The commit comparison is what
  // catches a deploy that silently did nothing, or a check pointed at the wrong
  // revision - so an empty EXPECT_SHA used to disable exactly the check that
  // exists for the failure hardest to notice. Now it refuses, and a human
  // checking an environment by hand passes --any-commit on purpose.
  const anyCommit = process.argv.includes("--any-commit");
  const sha = (process.env.EXPECT_SHA || "").trim();
  if (!sha && !anyCommit) {
    console.error(
      "deploy-smoke: EXPECT_SHA is not set. Pass the commit being deployed, or --any-commit to " +
        "check an environment without comparing what it is running.",
    );
    process.exit(1);
  }
  const expected = { env: process.env.EXPECT_ENV || "uat", sha: sha || undefined };

  const first = await waitForAnswer(base);
  if ("error" in first) {
    console.error(`deploy-smoke: ${first.error}`);
    console.error(`deploy-smoke: gave up after ${READY_TIMEOUT_MS / 1000}s. Not moving traffic.`);
    process.exit(1);
  }

  const deep = await fetchJson(`${base}/api/health?deep=1`, { authorization: `Bearer ${secret}` });
  if ("error" in deep) {
    console.error(`deploy-smoke: ${deep.error}`);
    process.exit(1);
  }

  const verdict = evaluateDeployHealth(first.body, deep.body, expected);

  if (verdict.warnings?.length) {
    console.log(`deploy-smoke: warnings (not blocking): ${verdict.warnings.join(", ")}`);
  }

  if (!verdict.ok) {
    console.error("deploy-smoke: NOT moving traffic to this revision:");
    for (const p of verdict.problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  console.log(
    `deploy-smoke: healthy. env=${first.body.env} commit=${first.body.sha} ` +
      `supplier=${deep.body.supplier} database=${deep.body.database}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`deploy-smoke: ${err?.message ?? err}`);
    process.exit(1);
  });
}
