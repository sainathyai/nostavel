// Run: npm run test:agents
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPrTitle, PR_TITLE_PATTERN } from "./pr-title.mjs";

test("accepts a title starting with the ticket key this pull request is named for", () => {
  assert.equal(checkPrTitle("NOS-21 split CI").ok, true, "the owner named NOS-21 explicitly as a valid title");
});

test("accepts other ticket keys and digit counts", () => {
  assert.equal(checkPrTitle("NOS-1 one digit").ok, true);
  assert.equal(checkPrTitle("NOS-2200 four digits").ok, true);
  assert.equal(checkPrTitle("ABC-9 a different project key").ok, true);
});

test("rejects a title with no ticket key at all", () => {
  assert.equal(checkPrTitle("fix ci").ok, false);
});

test("rejects a key with no number", () => {
  assert.equal(checkPrTitle("NOS- fix ci").ok, false);
  assert.equal(checkPrTitle("NOS fix ci").ok, false);
});

test("rejects a key glued to the rest of the title with no space", () => {
  assert.equal(checkPrTitle("NOS-21fix ci").ok, false);
});

test("rejects a lower-case key", () => {
  assert.equal(checkPrTitle("nos-21 fix ci").ok, false);
});

// Decision (NOS-22): the title must match docs/team/workflow.md's stated format,
// "NOS-<n> <what changed>", exactly - a bare key and a space, nothing else. A colon
// or brackets are not that format, so both are rejected rather than silently accepted.
test("rejects a colon after the key", () => {
  assert.equal(checkPrTitle("NOS-21: split CI").ok, false);
});

test("rejects the key in brackets", () => {
  assert.equal(checkPrTitle("[NOS-21] split CI").ok, false);
});

test("a rejection names the offending title and the expected pattern", () => {
  const result = checkPrTitle("fix ci");
  assert.equal(result.ok, false);
  assert.match(result.message, /fix ci/, "quotes the offending title");
  assert.match(result.message, new RegExp(PR_TITLE_PATTERN.source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "states the expected pattern");
});

test("empty title is rejected, not treated as a pass", () => {
  assert.equal(checkPrTitle("").ok, false);
});
