#!/usr/bin/env node
// Enforces the pull request title rule in docs/team/workflow.md: "Title: NOS-<n>
// <what changed>. The key is what links the change back to the ticket." Any
// project key works, not only NOS, so a future ticket prefix needs no change here.
//
//   node scripts/pr-title.mjs   reads PR_TITLE from the environment, exits non-zero
//                                and prints why if it doesn't match
//
// The title comes from a GitHub Actions `env:` value (workflow: ci.yml), never
// interpolated into a `run:` block - a fork pull request's title is
// attacker-controlled text, and that would be a script-injection vector.
import { pathToFileURL } from "node:url";

// Decision (NOS-22): docs/team/workflow.md states the format as exactly
// "NOS-<n> <what changed>" - a bare key, a space, nothing else. `NOS-21:` and
// `[NOS-21]` are both common alternatives elsewhere but are not that format, so
// both are rejected rather than silently accepted (see pr-title.test.mjs).
export const PR_TITLE_PATTERN = /^[A-Z][A-Z0-9]*-\d+ /;

/** @param {string} title @returns {{ok: true} | {ok: false, message: string}} */
export function checkPrTitle(title) {
  if (PR_TITLE_PATTERN.test(title)) return { ok: true };
  return {
    ok: false,
    message: `pr-title: "${title}" does not start with a ticket key.\n` +
      `Expected pattern: ${PR_TITLE_PATTERN.source} (example: "NOS-21 split CI").\n` +
      "See docs/team/workflow.md#pull-requests.",
  };
}

function main() {
  const title = process.env.PR_TITLE ?? "";
  const result = checkPrTitle(title);
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }
  console.log(`pr-title: "${title}" OK`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
