// AC 3: exactly one h1 per page, and no skipped heading level.
// InfoPage (src/components/InfoPage.tsx) emits exactly one h1 (the `title`
// prop); Section emits h2. This is expected to pass unmodified — a failure
// here is a real finding, not a test to relax.
import { test, expect } from "@playwright/test";
import { STATIC_PAGES } from "./support/pages";

for (const { path, h1 } of STATIC_PAGES) {
  test(`has exactly one h1, matching the page title, and no skipped heading level on ${path}`, async ({ page }) => {
    // No `waitUntil: "networkidle"`: it can hang on background retries
    // instead of reporting a clear failure. `toHaveCount`/`toHaveText` below
    // are web-first assertions — they poll for the real condition this test
    // depends on.
    await page.goto(path);

    await expect(page.locator("h1"), `expected exactly one h1 on ${path}`).toHaveCount(1);
    await expect(page.locator("h1")).toHaveText(h1);

    const levels = await page.evaluate(() =>
      Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6")).map((el) => Number(el.tagName.slice(1)))
    );

    expect(levels[0], `first heading on ${path} should be an h1, found h${levels[0]}`).toBe(1);

    for (let i = 1; i < levels.length; i++) {
      const jump = levels[i] - levels[i - 1];
      expect(
        jump,
        `heading level jumps from h${levels[i - 1]} to h${levels[i]} on ${path} (position ${i}) — a skipped level`
      ).toBeLessThanOrEqual(1);
    }
  });
}
