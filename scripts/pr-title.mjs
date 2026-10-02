#!/usr/bin/env node
// Enforces the pull request title rule in docs/team/workflow.md: "Title: NOS-<n>
// <what changed>. The key is what links the change back to the ticket." Any
// project key works, not only NOS, so a future ticket prefix needs no change here.
//
//   node scripts/pr-title.mjs   reads PR_TITLE and PR_AUTHOR from the environment,
//                                exits non-zero and prints why if they don't match
//
// Both values come from GitHub Actions `env:` values (workflow: ci.yml), never
// interpolated into a `run:` block - a fork pull request's title is
// attacker-controlled text, and that would be a script-injection vector.
import { pathToFileURL } from "node:url";

// Decision (NOS-22): docs/team/workflow.md states the format as exactly
// "NOS-<n> <what changed>" - a bare key, a space, nothing else. `NOS-21:` and
// `[NOS-21]` are both common alternatives elsewhere but are not that format, so
// both are rejected rather than silently accepted (see pr-title.test.mjs).
export const PR_TITLE_PATTERN = /^[A-Z][A-Z0-9]*-\d+ /;

// Decision (NOS-43): the ticket-key rule blocked every Dependabot pull request - a bot
// has no ticket, because no human filed one - and since pr-title is in the `checks`
// aggregator's needs: list, that left the required check red and a `next` security bump
// unmergeable (PRs #26, #27).
//
// The exemption is by author login, not by `user.type == "Bot"`: an allow-list of the
// bots that actually open pull requests here, so a future installed GitHub App does not
// inherit a pass it was never granted. Anything that is not exactly one of these logins
// is a person as far as this check is concerned. GitHub does not allow `[` or `]` in a
// username, so "dependabot[bot]" cannot be registered by a human or claimed by a fork.
export const BOT_AUTHORS = new Set(["dependabot[bot]"]);

// Being a known bot exempts a title from the ticket key, not from saying what it changes.
// Dependabot's own title form - a conventional-commit dependency prefix, then a
// description - is what is accepted: "build(deps): Bump next from 16.3.5 to 16.3.8",
// "build(deps-dev): ...", "build(deps): Bump the npm_and_yarn group with 3 updates", and
// a transitive security bump with no version range, "build(deps): Bump brace-expansion".
// `chore(deps)` is accepted too, since that is the other prefix a Dependabot config can
// produce. If Dependabot's prefix is ever reconfigured past these (dependabot.yml,
// `commit-message.prefix`), this gate goes red and names what it expected - the loud
// failure is deliberate, and far better than a bot exemption that accepts any title.
export const DEPENDENCY_TITLE_PATTERN = /^(?:build|chore)\(deps(?:-dev)?\): \S/;

/**
 * @param {string} title the pull request title
 * @param {string} [author] the pull request author's login
 *   (`github.event.pull_request.user.login`). Absent or empty is treated as a person:
 *   if ci.yml's `env: PR_AUTHOR` is ever dropped, this check tightens back to requiring
 *   a ticket key of everyone rather than quietly widening the exemption.
 * @returns {{ok: true} | {ok: false, message: string}}
 */
export function checkPrTitle(title, author) {
  if (PR_TITLE_PATTERN.test(title)) return { ok: true };
  if (typeof author === "string" && BOT_AUTHORS.has(author)) {
    if (DEPENDENCY_TITLE_PATTERN.test(title)) return { ok: true };
    return {
      ok: false,
      message: `pr-title: "${title}" is from the known bot ${author}, which is exempt from the\n` +
        "ticket-key rule, but the title is not a dependency update either.\n" +
        `Expected pattern: ${PR_TITLE_PATTERN.source} (example: "NOS-21 split CI")\n` +
        `             or: ${DEPENDENCY_TITLE_PATTERN.source} ` +
        '(example: "build(deps): Bump next from 16.3.5 to 16.3.8").\n' +
        "See docs/team/workflow.md#pull-requests.",
    };
  }
  return {
    ok: false,
    message: `pr-title: "${title}" does not start with a ticket key.\n` +
      `Expected pattern: ${PR_TITLE_PATTERN.source} (example: "NOS-21 split CI").\n` +
      "See docs/team/workflow.md#pull-requests.",
  };
}

function main() {
  const title = process.env.PR_TITLE ?? "";
  const author = process.env.PR_AUTHOR ?? "";
  const result = checkPrTitle(title, author);
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }
  console.log(`pr-title: "${title}" OK`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
