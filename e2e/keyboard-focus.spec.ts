// AC 2: keyboard-only navigation reaches the header logo link, the "Back to
// search" link, the ThemeToggle button and all six footer links, in that
// order, each with a visible focus indicator.
//
// No fixed sleeps anywhere here: the only wait before tabbing starts is an
// explicit `expect(header).toBeVisible()` (deterministic — tied to the thing
// this test actually depends on, not a network-idle heuristic that can hang
// if anything keeps retrying in the background), and every subsequent check
// reads `document.activeElement` straight after each key press rather than
// guessing a layout-settle delay (next/font's self-hosted fonts can still
// shift layout after first paint, but that does not change which element is
// focused or that element's own outline style, which is all this test reads).
//
// NOTE on what this test does NOT prove: it confirms the tab order among the
// elements that exist, but there is no skip link past the sticky header on
// any of these pages — the first tab stop is always the header wordmark, so
// a keyboard user re-tabs through the whole header on every page navigation.
// axe's `skip-link` rule does not catch this (it only validates an existing
// skip link's target; with none present it reports `inapplicable`, not a
// violation — see e2e/support/axe-baseline.ts). Tracked as NOS-42
// (https://syrav.atlassian.net/browse/NOS-42), not fixed here.
import { test, expect, type Page } from "@playwright/test";
import { STATIC_PAGES, FOOTER_LINKS } from "./support/pages";

interface FocusedElement {
  tagName: string;
  href: string | null;
  text: string;
  outlineStyle: string;
  outlineWidth: string;
}

async function readFocusedElement(page: Page): Promise<FocusedElement> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) {
      return { tagName: "", href: null, text: "", outlineStyle: "none", outlineWidth: "0px" };
    }
    const style = getComputedStyle(el);
    return {
      tagName: el.tagName,
      href: el instanceof HTMLAnchorElement ? el.getAttribute("href") : null,
      text: (el.textContent ?? "").trim(),
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
    };
  });
}

interface ExpectedStop {
  name: string;
  matches: (el: FocusedElement) => boolean;
}

function buildExpectedStops(): ExpectedStop[] {
  const footerStops: ExpectedStop[] = FOOTER_LINKS.map((link) => ({
    name: `footer link "${link.text}"`,
    matches: (el) => el.tagName === "A" && el.href === link.href && el.text === link.text,
  }));

  return [
    {
      name: "header logo link",
      matches: (el) => el.tagName === "A" && el.href === "/" && el.text === "Nostavel",
    },
    {
      name: '"Back to search" link',
      matches: (el) => el.tagName === "A" && el.href === "/" && el.text === "Back to search",
    },
    {
      name: "ThemeToggle button",
      matches: (el) => el.tagName === "BUTTON" && (el.text === "Daylight" || el.text === "Dusk"),
    },
    ...footerStops,
  ];
}

// Comfortably more than the handful of focusable stops any one of these
// pages has (header: 3, an occasional in-copy link such as /support's
// mailto, footer: 6), so the loop always has room to reach every expected
// stop without running forever on a failure.
const MAX_TAB_PRESSES = 25;

for (const { path } of STATIC_PAGES) {
  test(`tabs through header, theme toggle and footer links in order, each with a visible focus ring, on ${path}`, async ({
    page,
  }) => {
    await page.goto(path);
    // Deterministic readiness check: the header (and the logo link inside
    // it, the first expected tab stop) must actually be on screen before the
    // first Tab press, rather than guessing how long that takes.
    await expect(page.locator("header")).toBeVisible();

    const expectedStops = buildExpectedStops();
    let nextStopIndex = 0;
    const visited: string[] = [];

    for (let i = 0; i < MAX_TAB_PRESSES && nextStopIndex < expectedStops.length; i++) {
      await page.keyboard.press("Tab");
      const focused = await readFocusedElement(page);
      visited.push(`${focused.tagName} "${focused.text}" href=${focused.href ?? "—"}`);

      const expected = expectedStops[nextStopIndex];
      if (expected.matches(focused)) {
        expect(focused.outlineStyle, `${expected.name} has no visible focus ring (outline-style)`).toBe("solid");
        expect(focused.outlineWidth, `${expected.name} has no visible focus ring (outline-width)`).toBe("2px");
        nextStopIndex++;
      }
    }

    expect(
      nextStopIndex,
      `did not reach every expected stop, in order, within ${MAX_TAB_PRESSES} tab presses on ${path}.\n` +
        `Reached "${expectedStops[nextStopIndex]?.name}" next; tab sequence so far was:\n${visited.join("\n")}`
    ).toBe(expectedStops.length);
  });
}
