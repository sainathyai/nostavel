// Run: npm run test:agents
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateChecks, parseNeedsEnv } from "./ci-checks-result.mjs";

const success = (result) => ({ result });

// Criterion: every needed job succeeded, on a pull_request event, including
// pr-title (it runs on pull_request).
test("passes when every needed job succeeded on a pull_request event", () => {
  const needs = {
    guard: success("success"),
    lint: success("success"),
    build: success("success"),
    "pr-title": success("success"),
  };
  assert.equal(evaluateChecks(needs, "pull_request").ok, true);
});

// Criterion 7: pr-title has an `if:` that scopes it to pull_request events, so on
// a push to main it is legitimately skipped - that must still pass.
test("passes on a push event when pr-title is skipped, because it never runs there", () => {
  const needs = {
    guard: success("success"),
    lint: success("success"),
    build: success("success"),
    "pr-title": success("skipped"),
  };
  assert.equal(evaluateChecks(needs, "push").ok, true);
});

test("fails and names the job when a needed job failed", () => {
  const needs = { guard: success("success"), lint: success("failure") };
  const result = evaluateChecks(needs, "pull_request");
  assert.equal(result.ok, false);
  assert.match(result.message, /lint/);
});

// This is the case a bare `needs:` list does not catch: a skipped dependency does
// not make the needs list itself fail, only an explicit check of each result does.
test("fails and names the job when a needed job was skipped", () => {
  const needs = { guard: success("success"), lint: success("skipped") };
  const result = evaluateChecks(needs, "pull_request");
  assert.equal(result.ok, false);
  assert.match(result.message, /lint/);
});

test("fails and names the job when a needed job was cancelled", () => {
  const needs = { guard: success("success"), build: success("cancelled") };
  const result = evaluateChecks(needs, "pull_request");
  assert.equal(result.ok, false);
  assert.match(result.message, /build/);
});

// Criterion: pr-title silently not running on a pull_request is exactly the
// regression this script exists to catch.
test("fails when pr-title is skipped on a pull_request event", () => {
  const needs = { guard: success("success"), "pr-title": success("skipped") };
  const result = evaluateChecks(needs, "pull_request");
  assert.equal(result.ok, false);
  assert.match(result.message, /pr-title/);
});

// A required check that goes green having verified nothing is the exact failure
// mode this script exists to close, one level up: a dropped `env:` mapping, a
// typo in NEEDS_JSON, or a future edit that trims the needs: list must all be
// failures here, not silent passes.
test("fails on an empty needs-context, rather than reporting 0 jobs as a pass", () => {
  const result = evaluateChecks({}, "pull_request");
  assert.equal(result.ok, false);
});

test("fails when the needs-context is absent (undefined), not treated as empty-and-fine", () => {
  const result = evaluateChecks(undefined, "pull_request");
  assert.equal(result.ok, false);
});

test("parseNeedsEnv fails when NEEDS_JSON is not set, naming the variable", () => {
  const result = parseNeedsEnv(undefined);
  assert.equal(result.ok, false);
  assert.match(result.message, /NEEDS_JSON/);
});

test("parseNeedsEnv fails on malformed JSON with a clear message, not a raw throw", () => {
  const result = parseNeedsEnv("{not json");
  assert.equal(result.ok, false);
  assert.match(result.message, /NEEDS_JSON/);
  assert.match(result.message, /not valid JSON/);
});

test("parseNeedsEnv passes the parsed needs-context through on valid JSON", () => {
  const result = parseNeedsEnv('{"guard":{"result":"success"}}');
  assert.equal(result.ok, true);
  assert.deepEqual(result.needs, { guard: { result: "success" } });
});
