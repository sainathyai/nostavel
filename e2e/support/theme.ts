// Helpers for exercising the `data-theme` mechanism specifically (AC 6), as
// distinct from the `prefers-color-scheme` mechanism playwright.config.ts's
// four projects already drive via their `colorScheme` setting (AC 5).
// Without this file, a spec could only ever see one theme per project run,
// which would let the light-only /support contrast baseline entry
// (axe-baseline.ts) pass vacuously on any project that happens to emulate
// dark. See src/components/ThemeToggle.tsx for the mechanism this mirrors.
import { expect, type Page } from "@playwright/test";
import type { Theme } from "./types";

// Mirrors the constant in src/components/ThemeToggle.tsx. Duplicated, not
// imported: ThemeToggle is a "use client" React component evaluated in the
// browser, not something this Node-side test file can import. Keep the two
// in sync by hand if that file ever renames the key.
export const THEME_STORAGE_KEY = "nostavel:theme";

// The body's background colour is driven entirely by the --parchment token
// (src/app/globals.css), which is exactly what `data-theme` is supposed to
// flip. Comparing computed colour (not just the attribute) is what proves
// the override actually took visual effect, rather than the attribute
// merely being present and unstyled.
const PARCHMENT_RGB: Record<Theme, string> = {
  light: "rgb(245, 239, 230)", // --parchment: #f5efe6
  dark: "rgb(23, 19, 31)", // --parchment: #17131f
};

/**
 * Navigates to `path` with `data-theme` forced to `theme` via localStorage,
 * seeded before any page script runs so ThemeToggle's mount effect applies
 * it exactly as it would for a returning visitor, regardless of what the
 * current Playwright project's `colorScheme` emulates.
 *
 * Every test in this suite gets Playwright's default fresh, isolated
 * browser context (playwright.config.ts configures no `storageState`
 * anywhere), so there is nothing here that needs cleaning up afterwards.
 * The explicit `localStorage.removeItem` below is defensive, in case a
 * future spec ever navigates more than once within a single test.
 */
export async function forceDataTheme(page: Page, theme: Theme, path: string): Promise<void> {
  await page.addInitScript(
    ({ key, value }) => {
      localStorage.removeItem(key);
      localStorage.setItem(key, value);
    },
    { key: THEME_STORAGE_KEY, value: theme }
  );
  // `waitUntil: "networkidle"` is deliberately not used: it waits for 500ms
  // of no network activity, which can hang indefinitely if anything keeps
  // retrying in the background, turning a clean assertion failure into an
  // opaque timeout. `toHaveAttribute` below is the deterministic wait this
  // function actually needs — it polls until ThemeToggle's mount effect has
  // run and stamped the attribute, or reports a clear failure.
  await page.goto(path);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

/** Asserts the forced (or ambient) theme is actually painted, not just named. */
export async function expectThemeTookEffect(page: Page, theme: Theme): Promise<void> {
  const backgroundColor = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(backgroundColor, `body background did not resolve to the ${theme} --parchment token`).toBe(
    PARCHMENT_RGB[theme]
  );
}
