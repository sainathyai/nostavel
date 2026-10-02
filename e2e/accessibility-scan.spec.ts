// AC 4: a full-page axe scan, asserted against the documented baseline in
// e2e/support/axe-baseline.ts (see that file for why a bare "zero serious/
// critical violations" assertion is unsatisfiable without editing src/, and
// what the baseline is instead).
//
// This scan runs under whichever colorScheme the current Playwright project
// emulates (playwright.config.ts's four projects: AC 5's light/dark x 375/
// 1280 matrix). e2e/theme-attribute.spec.ts additionally forces `data-theme`
// explicitly (AC 6) so the baseline is exercised deterministically rather
// than only on whichever project happens to pick the affected theme.
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { STATIC_PAGES } from "./support/pages";
import { assertAxeResultsMatchBaseline } from "./support/axe-baseline";
import type { Theme } from "./support/types";

for (const { path } of STATIC_PAGES) {
  test(`full-page axe scan reports no un-baselined serious/critical violation on ${path}`, async ({ page }, testInfo) => {
    // No `waitUntil: "networkidle"`: it can hang on background retries
    // instead of reporting a clear failure. axe scans whatever DOM exists at
    // the moment `analyze()` runs, so the deterministic wait this test needs
    // is for the page's own content to actually be there first.
    await page.goto(path);
    await expect(page.locator("h1")).toBeVisible();

    const theme: Theme = testInfo.project.use.colorScheme === "dark" ? "dark" : "light";

    const results = await new AxeBuilder({ page }).analyze();
    assertAxeResultsMatchBaseline(results, path, theme);
  });
}
