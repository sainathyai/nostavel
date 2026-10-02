// Run: npm run test:agents
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPrTitle, PR_TITLE_PATTERN, DEPENDENCY_TITLE_PATTERN, BOT_AUTHORS } from "./pr-title.mjs";

// The author a human pull request carries. Passed explicitly in the tests below that
// care about the bot exemption, so "a human is not exempt" is asserted and not merely
// implied by leaving the argument off.
const HUMAN = "sainathyai";

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

// NOS-43: the ticket-key rule blocked every Dependabot pull request, including a `next`
// security bump, because a bot has no ticket to reference. Found by watching `checks` go
// red on PRs #26 and #27, where every other job passed.
//
// The exemption requires BOTH halves - a known bot author AND a dependency-update title.
// Either half alone is a hole, so each is asserted on its own below.

test("accepts a Dependabot version bump, which has no ticket to reference", () => {
  // The exact title of PR #27, the blocked `next` bump that found this bug.
  assert.equal(checkPrTitle("build(deps): Bump next from 16.3.5 to 16.3.8", "dependabot[bot]").ok, true);
});

test("accepts a Dependabot security bump that names no version range", () => {
  // The exact title of PR #26: a transitive security update, so no "from X to Y".
  assert.equal(checkPrTitle("build(deps): Bump brace-expansion", "dependabot[bot]").ok, true);
});

test("accepts the other title forms Dependabot sends: dev dependencies, groups, lower-case bump", () => {
  assert.equal(checkPrTitle("build(deps-dev): Bump vitest from 4.0.0 to 4.0.1", "dependabot[bot]").ok, true);
  assert.equal(checkPrTitle("build(deps): Bump the npm_and_yarn group with 3 updates", "dependabot[bot]").ok, true);
  assert.equal(checkPrTitle("build(deps): bump actions/checkout from 4 to 5", "dependabot[bot]").ok, true);
  assert.equal(checkPrTitle("chore(deps): Bump next from 16.3.5 to 16.3.8", "dependabot[bot]").ok, true);
});

// The allowed look-alike (.agents/rules/tests.md): the exemption must not become a way
// for a person to opt out of the ticket-key rule by copying a bot's title.
test("rejects a human using the bot's title format, so the ticket rule cannot be opted out of", () => {
  const result = checkPrTitle("build(deps): Bump next from 16.3.5 to 16.3.8", HUMAN);
  assert.equal(result.ok, false, "a human pull request still needs its ticket key");
  assert.match(result.message, /ticket key/);
});

// The other half: a bot author is exempt from the *ticket key*, not from having a
// meaningful title. If Dependabot's title format ever changes, this gate goes red and
// says so rather than silently accepting anything a bot sends.
test("rejects a bot title that is not a dependency update", () => {
  assert.equal(checkPrTitle("fix ci", "dependabot[bot]").ok, false);
  assert.equal(checkPrTitle("", "dependabot[bot]").ok, false);
  assert.equal(checkPrTitle("build(deps): ", "dependabot[bot]").ok, false, "a prefix with no description is not a bump");
  assert.equal(checkPrTitle("build(deps):Bump next", "dependabot[bot]").ok, false, "no space after the prefix");
  assert.equal(checkPrTitle("build(other): Bump next", "dependabot[bot]").ok, false, "deps scope only");
});

test("a rejected bot title names the bot form that was expected, not just the ticket key", () => {
  const result = checkPrTitle("fix ci", "dependabot[bot]");
  assert.equal(result.ok, false);
  assert.match(result.message, /dependabot\[bot\]/, "names the author it recognised");
  assert.match(result.message, new RegExp(DEPENDENCY_TITLE_PATTERN.source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "states the dependency-update pattern it expected instead");
});

// Fails closed on the author: anything that is not exactly a listed bot login is a
// person as far as this check is concerned. `[` and `]` are not legal in a GitHub
// username, so "dependabot[bot]" cannot be claimed by a human or a fork - but a
// look-alike login must not inherit the exemption either.
test("rejects a login that merely resembles the bot's", () => {
  for (const author of ["dependabot", "Dependabot[bot]", "dependabot[bot] ", " dependabot[bot]",
    "notdependabot[bot]", "dependabot[bot]x", "dependabot-bot"]) {
    assert.equal(checkPrTitle("build(deps): Bump next from 1 to 2", author).ok, false,
      `"${author}" must not be treated as the bot`);
  }
});

test("a missing or empty author is treated as a person, not as a bot", () => {
  // If ci.yml's `env: PR_AUTHOR` is ever dropped, the check tightens back to requiring a
  // ticket key for everyone - loudly, on the next bot pull request - rather than opening up.
  assert.equal(checkPrTitle("build(deps): Bump next from 1 to 2").ok, false);
  assert.equal(checkPrTitle("build(deps): Bump next from 1 to 2", "").ok, false);
  assert.equal(checkPrTitle("build(deps): Bump next from 1 to 2", undefined).ok, false);
  assert.equal(checkPrTitle("build(deps): Bump next from 1 to 2", null).ok, false);
});

test("a bot may still use a ticket key, if a human retitles its pull request", () => {
  assert.equal(checkPrTitle("NOS-43 bump next to 16.3.8", "dependabot[bot]").ok, true);
});

test("the bot allow-list holds only the bots that open pull requests in this repository", () => {
  // Deliberately exact: adding a bot is a decision, so it should break this test and be
  // made on purpose, not arrive as a side effect of a looser author match.
  assert.deepEqual([...BOT_AUTHORS], ["dependabot[bot]"]);
});
