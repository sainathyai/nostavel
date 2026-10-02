// AC 6: the `data-theme` attribute ThemeToggle.tsx stamps on <html> (and
// persists to localStorage under "nostavel:theme") is its own mechanism,
// separate from the `prefers-color-scheme` mechanism playwright.config.ts's
// `colorScheme` projects drive. This file forces data-theme explicitly, in
// both directions, independent of whatever colorScheme the current project
// emulates, and confirms it actually took visual effect (a computed colour),
// not just that the attribute string is present.
//
// Why this matters beyond the attribute itself: the /support contrast
// baseline entry (e2e/support/axe-baseline.ts) is specific to the light
// theme. A test that only ever reads whichever theme a project happens to
// be in would let that scan run in dark every time a dark-colorScheme
// project executes it, silently never exercising the light-only finding.
// Forcing data-theme here, and scanning again afterwards, closes that gap.
import { test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { STATIC_PAGES } from "./support/pages";
import { assertAxeResultsMatchBaseline } from "./support/axe-baseline";
import { forceDataTheme, expectThemeTookEffect } from "./support/theme";
import type { Theme } from "./support/types";

const THEMES: readonly Theme[] = ["light", "dark"];

for (const { path } of STATIC_PAGES) {
  test.describe(`data-theme attribute on ${path}`, () => {
    for (const theme of THEMES) {
      test(`data-theme="${theme}" overrides the page and is reflected in computed colour`, async ({ page }) => {
        await forceDataTheme(page, theme, path);
        await expectThemeTookEffect(page, theme);
      });

      test(`full-page axe scan under forced data-theme="${theme}" matches the documented baseline`, async ({
        page,
      }) => {
        await forceDataTheme(page, theme, path);
        await expectThemeTookEffect(page, theme);

        const results = await new AxeBuilder({ page }).analyze();
        assertAxeResultsMatchBaseline(results, path, theme);
      });
    }

    // Every test above gets Playwright's default fresh, isolated browser
    // context (no `storageState` configured anywhere — see
    // playwright.config.ts), so a theme forced in one test cannot leak into
    // another. This test is the proof: with nothing forced, the page must
    // still follow whatever this project's own colorScheme emulates, not
    // whatever the previous test in this file happened to set.
    test("a fresh page with no stored theme follows the project's own colour-scheme default", async ({
      page,
    }, testInfo) => {
      // No `waitUntil: "networkidle"` — see support/theme.ts. The colour
      // scheme here is pure CSS (a `prefers-color-scheme` media query), so
      // it is already resolved by the time `load` fires; nothing here waits
      // on client JS or network silence.
      await page.goto(path);
      const ambientTheme: Theme = testInfo.project.use.colorScheme === "dark" ? "dark" : "light";
      await expectThemeTookEffect(page, ambientTheme);
    });
  });
}
