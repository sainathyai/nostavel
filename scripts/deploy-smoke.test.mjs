// Run: npm run test:agents
import { test } from "node:test";
import assert from "node:assert/strict";
import { RETRY_DELAY_MS, evaluateDeployHealth, waitForAnswer } from "./deploy-smoke.mjs";

const healthy = (overrides = {}) => ({ ok: true, env: "uat", sha: "abc1234", ...overrides });
const deepHealthy = (overrides = {}) => ({
  ok: true,
  env: "uat",
  sha: "abc1234",
  supplier: "sandbox",
  database: "ok",
  problems: [],
  ...overrides,
});
const expected = { env: "uat", sha: "abc1234" };

test("promotes a healthy sandbox copy running the commit that was deployed", () => {
  const verdict = evaluateDeployHealth(healthy(), deepHealthy(), expected);
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.problems, []);
});

// THE MONEY CHECK, and the second layer the NOS-60 review asked for: the
// environment refuses every request on a live key by itself, and the thing that
// moves traffic refuses too.
test("refuses to move traffic to a copy on a live supplier key", () => {
  const verdict = evaluateDeployHealth(healthy({ ok: false }), deepHealthy({ supplier: "live" }), expected);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((p) => /sandbox/.test(p)));
});

test("refuses any supplier value that is not explicitly sandbox", () => {
  // A missing or unrecognised value is not evidence of safety.
  for (const supplier of ["live", "missing", undefined, null, "", "SANDBOX", "sandbox "]) {
    const verdict = evaluateDeployHealth(healthy(), deepHealthy({ supplier }), expected);
    assert.equal(verdict.ok, false, `expected supplier=${JSON.stringify(supplier)} to block promotion`);
  }
});

test("refuses a copy that reports itself unhealthy", () => {
  const verdict = evaluateDeployHealth(healthy({ ok: false }), deepHealthy(), expected);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((p) => /unhealthy/.test(p)));
});

test("refuses a copy that cannot reach its database", () => {
  for (const database of ["unreachable", "not-checked", undefined]) {
    const verdict = evaluateDeployHealth(healthy(), deepHealthy({ database }), expected);
    assert.equal(verdict.ok, false, `expected database=${JSON.stringify(database)} to block promotion`);
  }
});

// An unconfigured image reports itself as something other than the environment
// name on purpose (NOS-60), so this is the check that catches the deploy whose
// APP_ENV never arrived - as well as a deploy pointed at the wrong service.
test("refuses a copy that does not know which environment it is", () => {
  for (const env of ["unconfigured", "local", "", undefined, "production"]) {
    const verdict = evaluateDeployHealth(healthy({ env }), deepHealthy(), expected);
    assert.equal(verdict.ok, false, `expected env=${JSON.stringify(env)} to block promotion`);
  }
});

// How a deploy that silently did nothing is caught. The commit is baked into the
// image, so a revision still running the previous one is a deploy that did not
// take effect - or a check pointed at the wrong revision.
test("refuses a copy running a different commit than the one deployed", () => {
  const verdict = evaluateDeployHealth(healthy({ sha: "0000000" }), deepHealthy(), expected);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((p) => /0000000/.test(p)));
});

test("does not compare commits when the deploy did not say which one it is", () => {
  // The permissive direction, so a manual run without EXPECT_SHA still works.
  const verdict = evaluateDeployHealth(healthy({ sha: "whatever" }), deepHealthy(), { env: "uat" });
  assert.equal(verdict.ok, true);
});

test("refuses on any fatal configuration problem, naming it", () => {
  const deep = deepHealthy({
    ok: false,
    problems: [{ code: "cron-secret-missing", severity: "fatal", message: "..." }],
  });
  const verdict = evaluateDeployHealth(healthy({ ok: false }), deep, expected);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((p) => /cron-secret-missing/.test(p)));
});

test("reports a warning without blocking the deploy", () => {
  // "No email key" is invisible until a guest does not get their confirmation,
  // so it is surfaced - but it is not a reason to refuse a deploy.
  const deep = deepHealthy({
    problems: [{ code: "email-key-missing", severity: "warn", message: "..." }],
  });
  const verdict = evaluateDeployHealth(healthy(), deep, expected);
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.warnings, ["email-key-missing"]);
});

test("reports several problems at once, so one run names them all", () => {
  const verdict = evaluateDeployHealth(
    healthy({ ok: false, env: "unconfigured" }),
    deepHealthy({ supplier: "live", database: "unreachable" }),
    expected,
  );
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.length >= 4, `expected several problems, got ${verdict.problems.length}`);
});

test("refuses when either health answer is not an object", () => {
  for (const bad of [null, undefined, "ok", 7]) {
    assert.equal(evaluateDeployHealth(bad, deepHealthy(), expected).ok, false);
    assert.equal(evaluateDeployHealth(healthy(), bad, expected).ok, false);
  }
});

test("says to check the operations secret when the detailed answer is unusable", () => {
  // The likeliest cause by far: CRON_SECRET in the workflow not matching the one
  // deployed to the environment. Worth naming, because the symptom otherwise
  // looks like the app being broken.
  const verdict = evaluateDeployHealth(healthy(), null, expected);
  assert.match(verdict.problems[0], /CRON_SECRET/);
});

test("keeps retrying a revision that has not finished starting, then gives up", async () => {
  // "Has not finished starting" and "is broken" are different answers, and only
  // the second should fail a deploy. The clock is injected so this does not wait.
  let attempts = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    attempts++;
    throw new Error("ECONNREFUSED");
  };
  try {
    let now = 0;
    const result = await waitForAnswer("https://example.invalid", {
      now: () => now,
      wait: async (ms) => {
        now += ms;
      },
    });
    assert.ok("error" in result);
    assert.ok(attempts > 1, "expected more than one attempt before giving up");
    assert.ok(attempts < 60, `expected a bounded number of attempts, got ${attempts}`);
    assert.ok(now >= RETRY_DELAY_MS);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("stops retrying as soon as the revision answers", async () => {
  let attempts = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    attempts++;
    if (attempts < 3) throw new Error("ECONNREFUSED");
    return new Response(JSON.stringify(healthy()), { status: 200 });
  };
  try {
    let now = 0;
    const result = await waitForAnswer("https://example.invalid", {
      now: () => now,
      wait: async (ms) => {
        now += ms;
      },
    });
    assert.equal(attempts, 3);
    assert.ok(!("error" in result));
    assert.equal(result.body.env, "uat");
  } finally {
    globalThis.fetch = realFetch;
  }
});
