// AC 5: pages hold together at 375px and 1280px, in light and dark.
// The viewport and colour scheme both come from which of the four
// playwright.config.ts projects is running this file — this spec is
// project-agnostic and just asserts the shared shell (header, h1, footer)
// renders without horizontal overflow at whatever combination is active.
import { test, expect } from "@playwright/test";
import { STATIC_PAGES } from "./support/pages";

for (const { path, h1 } of STATIC_PAGES) {
  test(`renders header, content and footer with no horizontal overflow on ${path}`, async ({ page }) => {
    // No `waitUntil: "networkidle"`: it can hang on background retries
    // instead of reporting a clear failure. The `toBeVisible` assertions
    // below are web-first — they poll for the real condition this test
    // depends on.
    await page.goto(path);

    await expect(page.getByRole("heading", { level: 1, name: h1 })).toBeVisible();
    await expect(page.locator("header")).toBeVisible();
    await expect(page.locator("footer")).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow, `${path} scrolls horizontally at this viewport`).toBeLessThanOrEqual(0);
  });
}
