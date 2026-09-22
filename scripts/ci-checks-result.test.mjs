// Run: npm run test:agents
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

// Criterion 1: only the exact string "success" passes. Everything below is a
// failure that names the job and the value actually seen, so "job X: neutral"
// reads differently from "job X: <missing>".

test("passes when every needed job's result is exactly the string success", () => {
  const needs = { guard: success("success"), build: success("success") };
  const result = evaluateChecks(needs, "push");
  assert.equal(result.ok, true);
});

test("fails and names the job when its result key is missing entirely", () => {
  const needs = { guard: success("success"), build: {} };
  const result = evaluateChecks(needs, "pull_request");
  assert.equal(result.ok, false);
  assert.match(result.message, /build: <missing>/);
});

test("fails and names the job when its result is null", () => {
  const needs = { guard: success("success"), build: success(null) };
  const result = evaluateChecks(needs, "pull_request");
  assert.equal(result.ok, false);
  assert.match(result.message, /build: null/);
});

test("fails and names the job when its result is an unknown string GitHub might add later", () => {
  const needs = { guard: success("success"), build: success("neutral") };
  const result = evaluateChecks(needs, "pull_request");
  assert.equal(result.ok, false);
  assert.match(result.message, /build: neutral/);
});

test("fails and names the job when its result is a startup_failure", () => {
  const needs = { guard: success("success"), build: success("startup_failure") };
  const result = evaluateChecks(needs, "pull_request");
  assert.equal(result.ok, false);
  assert.match(result.message, /build: startup_failure/);
});

test("fails and reports a missing result when a needed job's entry is not an object", () => {
  // A malformed NEEDS_JSON (or a future GitHub Actions change) could hand this
  // script a bare string or number instead of a `{result: ...}` object. Reading
  // `.result` off it is `undefined`, which must fail the same way an absent
  // key does, not throw and not silently pass.
  const needs = { guard: success("success"), build: "success" };
  const result = evaluateChecks(needs, "pull_request");
  assert.equal(result.ok, false);
  assert.match(result.message, /build: <missing>/);
});

// Criterion 2: the one intentional exemption stays exactly as narrow as today -
// pr-title skipped when the event is not pull_request, and nothing else.

test("passes when pr-title is skipped on a push event, because it never runs there", () => {
  const needs = { guard: success("success"), "pr-title": success("skipped") };
  const result = evaluateChecks(needs, "push");
  assert.equal(result.ok, true);
});

test("fails when pr-title is skipped on a pull_request event, naming pr-title and skipped", () => {
  const needs = { guard: success("success"), "pr-title": success("skipped") };
  const result = evaluateChecks(needs, "pull_request");
  assert.equal(result.ok, false);
  assert.match(result.message, /pr-title: skipped/);
});

test("fails when a job other than pr-title is skipped on a push event", () => {
  const needs = { guard: success("success"), build: success("skipped") };
  const result = evaluateChecks(needs, "push");
  assert.equal(result.ok, false);
  assert.match(result.message, /build: skipped/);
});

// Criterion 3: an absent or empty GITHUB_EVENT_NAME must fail loudly, not be
// read as "not a pull_request", which would otherwise silently forgive a
// skipped pr-title.

test("fails closed when GITHUB_EVENT_NAME is unset (empty string) and a job is skipped", () => {
  const needs = { guard: success("success"), "pr-title": success("skipped") };
  const result = evaluateChecks(needs, "");
  assert.equal(result.ok, false);
  assert.match(result.message, /GITHUB_EVENT_NAME is not set/);
  assert.match(result.message, /GitHub Actions always sets/);
});

test("fails closed when GITHUB_EVENT_NAME is undefined, even with every job passing", () => {
  const needs = { guard: success("success"), build: success("success") };
  const result = evaluateChecks(needs, undefined);
  assert.equal(result.ok, false);
  assert.match(result.message, /GITHUB_EVENT_NAME is not set/);
});

// Criterion 4: the checks job's needs: list in ci.yml must name every other job
// defined in the file, so a pull request that trims the list to dodge a slow or
// failing job is caught by the run it is trying to weaken.

/**
 * A small, dependency-free reader for exactly the shape ci.yml uses - it is not
 * a general YAML parser, and does not need to be one. Job names are the keys
 * directly under `jobs:` at 2-space indent (every job body is indented 4+
 * spaces, so this regex never matches a step or a job's own keys). The
 * `checks` job's `needs:` list is written as a single inline flow sequence
 * (`needs: [a, b, c]`), and it is the only `needs:` key in the file, so one
 * regex finds it. Kept here, next to the one test that uses it, rather than as
 * a project dependency: adding a real YAML parser to parse one workflow file
 * would be a bigger dependency than the thing being tested.
 * @param {string} yamlText
 * @returns {{jobNames: string[], checksNeeds: string[]}}
 */
function parseCiWorkflowJobs(yamlText) {
  const jobsSectionStart = yamlText.indexOf("\njobs:");
  if (jobsSectionStart === -1) throw new Error("ci.yml has no top-level jobs: section");
  const jobsSection = yamlText.slice(jobsSectionStart);
  const jobNames = [...jobsSection.matchAll(/^ {2}([A-Za-z0-9_-]+):/gm)].map((m) => m[1]);
  const needsMatch = yamlText.match(/^\s*needs:\s*\[([^\]]*)\]/m);
  if (!needsMatch) throw new Error("no needs: [...] flow sequence found in ci.yml");
  const checksNeeds = needsMatch[1].split(",").map((s) => s.trim()).filter(Boolean);
  return { jobNames, checksNeeds };
}

test("the checks job's needs: list names every other job defined in ci.yml", () => {
  const workflowPath = fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url));
  const yamlText = readFileSync(workflowPath, "utf8");
  const { jobNames, checksNeeds } = parseCiWorkflowJobs(yamlText);

  const otherJobs = jobNames.filter((name) => name !== "checks");
  assert.ok(otherJobs.length > 0, "expected ci.yml to define jobs besides checks");

  const missing = otherJobs.filter((name) => !checksNeeds.includes(name));
  assert.deepEqual(
    missing,
    [],
    `checks job's needs: list is missing: ${missing.join(", ")}. A pull request that trims ` +
      "needs: to dodge a job must be caught here, since the checks job would otherwise pass " +
      "without waiting for it."
  );

  const extra = checksNeeds.filter((name) => !jobNames.includes(name));
  assert.deepEqual(extra, [], `checks job's needs: list names jobs that don't exist: ${extra.join(", ")}`);
});
