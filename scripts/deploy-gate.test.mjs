// Run: npm run test:agents
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateDeployGate } from "./deploy-gate.mjs";

const plan = (result, pending) => ({
  result,
  ...(pending === undefined ? {} : { outputs: { pending: String(pending) } }),
});

// The ordinary merge: no migration in the change, so the migration job is
// skipped and nobody is asked to approve anything (D-5.4's refinement - an
// approval requested on every merge is one that gets clicked without reading).
test("deploys when nothing is pending and the migration job was skipped", () => {
  const result = evaluateDeployGate({ plan: plan("success", 0), migrate: { result: "skipped" } });
  assert.equal(result.ok, true);
  assert.match(result.message, /no database changes/);
});

// The approved merge: the owner was asked, said yes, and it ran.
test("deploys when migrations were pending and the migration job succeeded", () => {
  const result = evaluateDeployGate({ plan: plan("success", 2), migrate: { result: "success" } });
  assert.equal(result.ok, true);
  assert.match(result.message, /2 approved database change/);
});

// THE CASE THE WHOLE SCRIPT EXISTS FOR. A skipped migration job looks identical
// whether it was skipped because there was nothing to do or because the approval
// was never given. Without the plan's answer, this deploy would go out with the
// new code running against an un-migrated database.
test("refuses to deploy when migrations were pending and the migration job was skipped", () => {
  const result = evaluateDeployGate({ plan: plan("success", 1), migrate: { result: "skipped" } });
  assert.equal(result.ok, false);
  assert.match(result.message, /approval was never given/);
});

test("refuses to deploy when the migration failed", () => {
  const result = evaluateDeployGate({ plan: plan("success", 1), migrate: { result: "failure" } });
  assert.equal(result.ok, false);
  assert.match(result.message, /does not match/);
});

test("refuses to deploy when the migration was cancelled", () => {
  // A cancelled approval is a refusal, not a pass.
  const result = evaluateDeployGate({ plan: plan("success", 1), migrate: { result: "cancelled" } });
  assert.equal(result.ok, false);
});

// Same allow-list discipline as scripts/ci-checks-result.mjs: a result string
// GitHub adds later stops the deploy until this script is taught about it.
test("refuses to deploy on a migration result this script has not been taught", () => {
  for (const unknown of ["neutral", "startup_failure", "timed_out", ""]) {
    const result = evaluateDeployGate({ plan: plan("success", 0), migrate: { result: unknown } });
    assert.equal(result.ok, false, `expected ${JSON.stringify(unknown)} to block the deploy`);
  }
});

test("refuses to deploy when the migration result is missing, null or not a string", () => {
  for (const bad of [{}, { result: null }, { result: 7 }, { result: ["success"] }]) {
    const result = evaluateDeployGate({ plan: plan("success", 0), migrate: bad });
    assert.equal(result.ok, false);
  }
});

test("refuses to deploy when the plan job did not succeed", () => {
  for (const planResult of ["failure", "cancelled", "skipped"]) {
    const result = evaluateDeployGate({ plan: plan(planResult, 0), migrate: { result: "skipped" } });
    assert.equal(result.ok, false, `expected plan: ${planResult} to block the deploy`);
    assert.match(result.message, /plan/);
  }
});

// An unreadable plan must not be read as an empty one: that is the difference
// between "no migrations" and "we do not know", and only one of them is safe.
test("refuses to deploy when the plan did not report a pending count", () => {
  for (const raw of [undefined, "", "none", "0.5", "-1", "two", " 0"]) {
    const needs = {
      plan: { result: "success", outputs: raw === undefined ? {} : { pending: raw } },
      migrate: { result: "skipped" },
    };
    const result = evaluateDeployGate(needs);
    assert.equal(result.ok, false, `expected pending=${JSON.stringify(raw)} to block the deploy`);
    assert.match(result.message, /pending|plan/i);
  }
});

// The other direction: a migration that ran when the plan said there was nothing
// to run means the two disagree about what this deploy contains, and an
// unplanned database change is exactly what the gate exists to prevent.
test("refuses to deploy when the migration ran but nothing was planned", () => {
  const result = evaluateDeployGate({ plan: plan("success", 0), migrate: { result: "success" } });
  assert.equal(result.ok, false);
  assert.match(result.message, /disagree/);
});

test("refuses to deploy when either job is absent from the needs context", () => {
  assert.equal(evaluateDeployGate({ migrate: { result: "skipped" } }).ok, false);
  assert.equal(evaluateDeployGate({ plan: plan("success", 0) }).ok, false);
});

test("refuses to deploy when the needs context is not an object", () => {
  for (const bad of [null, undefined, "needs", 7, []]) {
    // An array is an object in JavaScript, so it reaches the per-job checks and
    // fails there; everything else fails the shape check. Both must block.
    assert.equal(evaluateDeployGate(bad).ok, false, `expected ${JSON.stringify(bad)} to block`);
  }
});
