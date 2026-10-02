// AC 7: these four pages render only InfoPage/Section (verified by reading
// src/app/about/page.tsx, src/app/how-it-works/page.tsx,
// src/app/terms/page.tsx and src/app/support/page.tsx directly — each
// imports nothing from Experience.tsx or StaysMap.tsx), and need no
// database, LITEAPI_BASE_URL or LITEAPI_KEY. The public basemap is down
// until Segment 6 (docs/conventions.md's "Maps" section), so no test here
// may depend on it either — this file instead proves these pages never even
// try to reach a map-tile or supplier host, so a future change that wires
// one of those onto a static page fails this suite loudly instead of
// quietly shipping a dependency on a thing that is currently down.
import { test, expect } from "@playwright/test";
import { STATIC_PAGES } from "./support/pages";

// Hostnames the app only ever talks to for the basemap or the LiteAPI
// supplier (src/components/map-style.ts, src/lib/liteapi.ts).
const FORBIDDEN_HOST_SUBSTRINGS = ["protomaps", "liteapi", "pmtiles"];

for (const { path } of STATIC_PAGES) {
  test(`issues no request to a supplier or map-tile host, and renders no map canvas, on ${path}`, async ({
    page,
  }) => {
    const forbiddenRequests: string[] = [];
    page.on("request", (request) => {
      const url = request.url();
      if (FORBIDDEN_HOST_SUBSTRINGS.some((host) => url.includes(host))) {
        forbiddenRequests.push(url);
      }
    });

    // No `waitUntil: "networkidle"`: it can hang on background retries
    // instead of reporting a clear failure. `request`/`response` listeners
    // above are attached before navigation and keep accumulating for the
    // test's whole lifetime regardless of when `goto` resolves; waiting for
    // the h1 below is the deterministic signal that the page actually
    // rendered (and had the chance to run any client JS, map included)
    // before this test inspects what was collected.
    const response = await page.goto(path);
    expect(response?.ok(), `navigation to ${path} did not return a 2xx response`).toBe(true);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    expect(
      forbiddenRequests,
      `${path} issued a request to a supplier/map-tile host it should never reach:\n${forbiddenRequests.join("\n")}`
    ).toEqual([]);

    // Belt and braces beyond network requests: no maplibre-gl rendering
    // target (StaysMap.tsx / HotelMap.tsx) should exist in the DOM either.
    expect(await page.locator("canvas.maplibregl-canvas").count()).toBe(0);
  });
}
