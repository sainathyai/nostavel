// Run: npm run test:agents
//
// NOS-34: compose.test.yml documents that both its images are pinned by
// sha256 digest (see that file's comment on how and when each digest was
// resolved), but nothing enforced it - a future edit back to a mutable tag
// (`:16-alpine`, `:main`) would pass every existing check. This test is that
// enforcement: it fails, naming the offending line, the moment any `image:`
// in compose.test.yml stops being pinned by digest.
//
// A real YAML parser is not worth adding for this: compose.test.yml's
// `image:` lines are always a plain scalar on their own line
// (`  image: <ref>`), so a line-oriented regex is enough, and a dependency
// that can parse arbitrary YAML would be a bigger addition than the check it
// supports. Same reasoning as scripts/ci-checks-result.test.mjs's
// parseCiWorkflowJobs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Finds every `image:` line in a compose file's text that is not pinned by a
 * sha256 digest (an `@sha256:` reference followed by exactly 64 hex
 * characters). Returns the offending lines, trimmed, one per unpinned image,
 * so a failure names exactly which line to fix.
 * @param {string} composeText
 * @returns {string[]}
 */
function findUnpinnedImages(composeText) {
  const offenders = [];
  for (const line of composeText.split(/\r?\n/)) {
    const match = line.match(/^\s*image:\s*(\S+)/);
    if (!match) continue;
    const image = match[1];
    if (!/@sha256:[0-9a-f]{64}$/.test(image)) {
      offenders.push(line.trim());
    }
  }
  return offenders;
}

test("accepts an image pinned by a 64-character sha256 digest", () => {
  const text = "services:\n  postgres:\n    image: postgres@sha256:" + "a".repeat(64) + " # postgres:16-alpine\n";
  assert.deepEqual(findUnpinnedImages(text), []);
});

test("refuses an image pinned only by a mutable tag, naming the offending line", () => {
  const text = "services:\n  postgres:\n    image: postgres:16-alpine\n";
  const offenders = findUnpinnedImages(text);
  assert.equal(offenders.length, 1);
  assert.match(offenders[0], /^image: postgres:16-alpine$/);
});

test("refuses :latest the same way as any other mutable tag", () => {
  const text = "  image: postgres:latest\n";
  assert.equal(findUnpinnedImages(text).length, 1);
});

test("refuses :main the same way as any other mutable tag", () => {
  const text = "  image: ghcr.io/timowilhelm/local-neon-http-proxy:main\n";
  assert.equal(findUnpinnedImages(text).length, 1);
});

test("refuses a digest that is the wrong length, rather than pattern-matching loosely", () => {
  const text = "  image: postgres@sha256:" + "a".repeat(10) + "\n"; // truncated digest
  assert.equal(findUnpinnedImages(text).length, 1);
});

test("names each offending image independently when more than one is unpinned", () => {
  const text = [
    "services:",
    "  postgres:",
    "    image: postgres:16-alpine",
    "  neon-proxy:",
    "    image: ghcr.io/timowilhelm/local-neon-http-proxy:main",
  ].join("\n");
  const offenders = findUnpinnedImages(text);
  assert.equal(offenders.length, 2);
  assert.match(offenders[0], /postgres:16-alpine/);
  assert.match(offenders[1], /local-neon-http-proxy:main/);
});

test("does not flag an image line that is already pinned by digest, among other unrelated lines", () => {
  const text = [
    "services:",
    "  postgres:",
    "    image: postgres@sha256:" + "b".repeat(64) + " # postgres:16-alpine",
    "    environment:",
    "      POSTGRES_DB: main",
  ].join("\n");
  assert.deepEqual(findUnpinnedImages(text), []);
});

test("compose.test.yml pins every image by sha256 digest", () => {
  const composePath = fileURLToPath(new URL("../compose.test.yml", import.meta.url));
  const composeText = readFileSync(composePath, "utf8");
  const offenders = findUnpinnedImages(composeText);
  assert.deepEqual(
    offenders,
    [],
    `compose.test.yml has image(s) not pinned by sha256 digest: ${offenders.join(", ")}. A mutable ` +
      "tag (e.g. :16-alpine, :main) can change under us without any check noticing - pin by digest " +
      "and note in a comment what tag and date it was resolved against, the way the existing images are.",
  );
});
