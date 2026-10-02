// AC 4 asks for a full-page axe scan that fails on a serious/critical
// violation. A bare "zero serious/critical violations" assertion is
// unsatisfiable without editing src/ (out of scope for this ticket): the
// --brass-on---parchment pairing (src/app/globals.css) is below the WCAG AA
// 4.5:1 floor for normal text in the light theme, at 3.20:1, and paints
// three different elements shared by every one of these pages. The owner has
// explicitly deferred fixing it (NOS-40).
//
// Rather than downgrade the rule, disable it, or skip a page, this is an
// explicit, documented baseline of known-accepted violations, keyed by page,
// theme, rule id and the specific element. The assertion built on top of it
// (below) is two-sided:
//   - a NEW serious/critical violation (not in this list) still fails the
//     suite, so a regression is caught;
//   - a baseline entry that stops reproducing ALSO fails the suite, so a fix
//     is noticed and the stale entry gets deleted rather than silently
//     rotting into a tolerance for a problem that no longer exists.
// Matching is per violating *node*, not per axe `Result` — axe groups every
// element failing the same rule on a page into one Result with several
// `nodes`. An earlier version of this file matched a whole Result the moment
// any one of its nodes matched a baseline entry, which silently swallowed
// the other, un-baselined nodes in that same Result. That is exactly the
// kind of scan gap this file exists to prevent, so the fix is recorded here:
// always iterate `violation.nodes`, never `violation` as a whole.
//
// Matching is also counted, not just checked for presence: each applicable
// entry must match `expectedNodes` nodes (default 1), no more and no fewer.
// A second, distinct element starting to match one entry's `targetIncludes`
// is a regression of the same species as the Result-vs-node bug above — a
// real new element silently absorbed by an existing entry — so it fails the
// suite exactly like an unmatched violation would, rather than passing
// because *an* entry matched *a* node. See `assertAxeResultsMatchBaseline`.
//
// Anything below "serious" is logged, never asserted here (AC 4).
//
// --- Two classes of defect this scan cannot see, at all (NOS-41, NOS-42) ---
// A green run of this file must not be read as "no contrast or keyboard
// problems" — that misreading is worse than having no check. Two confirmed,
// filed gaps:
//   - NOS-41: ThemeToggle's button border (--line on --parchment, ~1.23:1
//     light / ~1.39:1 dark) fails WCAG 1.4.11 (non-text contrast). axe-core's
//     default rule set has exactly one contrast rule, `color-contrast`, and
//     it only evaluates text. There is no 1.4.11 rule in axe-core at all —
//     not a violation, not `incomplete`, nothing — so no baseline entry here
//     could ever represent it, and no amount of running this suite will ever
//     surface it.
//   - NOS-42: there is no skip link past the sticky header on any of these
//     four pages (confirmed: the first focusable element on every page, in
//     every theme, is the header wordmark link). axe-core does have a
//     `skip-link` rule, but it only validates that an *existing* skip link's
//     target is focusable; with no skip link present at all, the rule
//     reports `inapplicable` (0 nodes) rather than a violation. It will
//     never fail this suite.
// Both are tracked as their own tickets rather than baseline entries here,
// because there is nothing for a baseline entry to key off: axe emits no
// finding for either one to match against.
import { expect } from "@playwright/test";
import type { AxeResults } from "axe-core";
import type { Theme } from "./types";

export interface AxeBaselineEntry {
  /** Route path this finding reproduces on, e.g. "/support". */
  page: string;
  /** Theme this finding reproduces in. Baseline entries are theme-specific
   *  on purpose — see the --brass/--parchment note below, where the dark
   *  pairing passes and the light one does not. */
  theme: Theme;
  /** axe-core rule id, e.g. "color-contrast". */
  ruleId: string;
  /** Severity axe reports today. Asserted too, so a severity change (better
   *  or worse) is noticed rather than silently absorbed by the baseline. */
  impact: "serious" | "critical";
  /** A substring expected in the violating node's `target` CSS selector
   *  (brackets un-escaped — see `normalizeTarget` below). A substring, not
   *  the full axe-generated selector string, because axe's own selector
   *  generation is not a contract this suite should pin character-for-
   *  character. Must be specific enough to identify one node and not a
   *  sibling that happens to share a class. */
  targetIncludes: string;
  /** How many distinct violating nodes this entry is expected to match on
   *  this page/theme. Defaults to 1 and is enforced exactly — not "at
   *  least" — because a count above this is as much a regression as a count
   *  below it: a second, different element starting to satisfy
   *  `targetIncludes` is a new, un-reviewed finding riding in on an old
   *  entry's back. Only set this above 1 when one documented finding
   *  genuinely and legitimately spans that many elements. */
  expectedNodes?: number;
  /** What this is, and that it is a product finding awaiting its own
   *  ticket — not test debt and not a false positive. */
  note: string;
}

// Shared provenance for every --brass-on---parchment entry below, so the
// measurement is written down once (docs/conventions.md §5) rather than
// copy-pasted and risking drift between copies.
const BRASS_ON_PARCHMENT_LIGHT =
  "Measured 2026-10-02 from src/app/globals.css: --brass (#b9772b) on --parchment (#f5efe6) is 3.20:1 in the " +
  "light theme, below the 4.5:1 WCAG AA floor for normal text. The identical pairing in the dark theme is " +
  "8.17:1 and passes — there is deliberately no dark-theme entry for this node; one appearing later is itself " +
  "a regression, not a reason to widen this baseline. Product finding, owner has deferred the fix. " +
  "NOS-40 (https://syrav.atlassian.net/browse/NOS-40): tracks all three sites / nine entries as one bug.";

export const AXE_BASELINE: AxeBaselineEntry[] = [
  {
    page: "/support",
    theme: "light",
    ruleId: "color-contrast",
    impact: "serious",
    // The mailto link's own href is distinctive enough on its own.
    targetIncludes: "help@nostavel.com",
    note: `help@nostavel.com mailto link (src/app/support/page.tsx, "text-brass underline"). ${BRASS_ON_PARCHMENT_LIGHT}`,
  },
  // The italic "vel" accent in the sticky header's wordmark
  // (src/components/InfoPage.tsx: `<Link ... className="... text-[20px]">
  // Nosta<span className="italic text-brass">vel</span></Link>`) is the same
  // token pairing, at normal (non-large) text size, on every one of these
  // four pages because InfoPage renders the header for all of them.
  ...(["/about", "/how-it-works", "/terms", "/support"] as const).map((page) => ({
    page,
    theme: "light" as const,
    ruleId: "color-contrast",
    impact: "serious" as const,
    targetIncludes: "text-[20px] > .italic.text-brass",
    note: `Header wordmark's italic "vel" (src/components/InfoPage.tsx). ${BRASS_ON_PARCHMENT_LIGHT}`,
  })),
  // The same accent in the site-wide footer's wordmark
  // (src/components/SiteFooter.tsx, rendered once in src/app/layout.tsx for
  // every page), at a smaller size but the same failing token pair.
  ...(["/about", "/how-it-works", "/terms", "/support"] as const).map((page) => ({
    page,
    theme: "light" as const,
    ruleId: "color-contrast",
    impact: "serious" as const,
    targetIncludes: "text-[15px].text-ink > .italic.text-brass",
    note: `Footer wordmark's italic "vel" (src/components/SiteFooter.tsx). ${BRASS_ON_PARCHMENT_LIGHT}`,
  })),
];

// axe's generated selectors escape Tailwind's bracket-notation classes for
// `querySelector` (e.g. `.text-\[20px\]`). Comparing against a baseline
// string that spells the class the way the component source does
// (`text-[20px]`) is easier to read and verify than requiring every
// `targetIncludes` entry above to also carry the escaping backslashes, so
// backslashes are stripped from both sides before comparing.
function normalizeTarget(target: unknown): string {
  return JSON.stringify(target).replace(/\\\\/g, "");
}

/**
 * Asserts an axe scan against the documented baseline for one page/theme
 * combination. Call once per (page, theme) the scan ran under.
 */
export function assertAxeResultsMatchBaseline(results: AxeResults, page: string, theme: Theme): void {
  const applicable = AXE_BASELINE.filter((entry) => entry.page === page && entry.theme === theme);
  const matchCounts = new Map<AxeBaselineEntry, number>();
  const unexpected: string[] = [];

  for (const violation of results.violations) {
    if (violation.impact !== "serious" && violation.impact !== "critical") continue;

    for (const node of violation.nodes) {
      const normalizedTarget = normalizeTarget(node.target);
      const match = applicable.find(
        (entry) =>
          entry.ruleId === violation.id &&
          entry.impact === violation.impact &&
          (normalizedTarget.includes(entry.targetIncludes) || node.html.includes(entry.targetIncludes))
      );
      if (match) {
        matchCounts.set(match, (matchCounts.get(match) ?? 0) + 1);
      } else {
        unexpected.push(`${violation.id} (${violation.impact}) on ${page} [${theme}]: ${normalizedTarget} — ${node.html}`);
      }
    }
  }

  expect(
    unexpected,
    `New serious/critical axe violation(s) outside the documented baseline (e2e/support/axe-baseline.ts):\n${unexpected.join("\n")}`
  ).toEqual([]);

  // Every applicable entry must match exactly `expectedNodes` nodes (default
  // 1) — not "at least". Zero means the finding stopped reproducing (delete
  // the entry); more than expected means a second, different element has
  // started satisfying `targetIncludes` and is riding in unreviewed on an
  // existing entry (split the entry, or raise `expectedNodes` deliberately
  // if that is genuinely correct). Either direction is a real problem this
  // suite exists to catch, so both fail the same way.
  const countMismatches = applicable
    .map((entry) => ({ entry, count: matchCounts.get(entry) ?? 0, expected: entry.expectedNodes ?? 1 }))
    .filter(({ count, expected }) => count !== expected);

  expect(
    countMismatches.map(({ entry, count, expected }) => {
      const where = `${entry.page} [${entry.theme}] ${entry.ruleId} (${entry.targetIncludes})`;
      if (count === 0) {
        return `${where}: matched 0 nodes (expected ${expected}) — this finding no longer reproduces; ` +
          `delete the stale entry rather than tolerate a problem that's already fixed. (${entry.note})`;
      }
      if (count > expected) {
        return `${where}: matched ${count} nodes but expected ${expected} — a different element now satisfies ` +
          `this entry's targetIncludes. Split it into one entry per element, or set expectedNodes: ${count} on ` +
          `this entry only if it genuinely and legitimately covers that many elements.`;
      }
      return `${where}: matched ${count} of ${expected} expected nodes.`;
    }),
    "Baseline entr(y/ies) in e2e/support/axe-baseline.ts did not match their expected node count — see messages above."
  ).toEqual([]);

  // Lower-severity findings are evidence, not an assertion (AC 4 only asks
  // for zero serious/critical). Logged so a human sees them without the
  // suite being able to fail over, say, a "moderate" finding nobody has
  // triaged yet.
  for (const violation of results.violations) {
    if (violation.impact === "serious" || violation.impact === "critical") continue;
    // Intentional: a visible, filterable finding log, not debug noise left behind.
    console.log(
      `[a11y finding] ${page} [${theme}] ${violation.impact ?? "unknown"}: ${violation.id} — ${violation.help} ` +
        `(${violation.nodes.length} node(s))`
    );
  }
}
