import { defineConfig } from "@playwright/test";

// Browser smoke tests (NOS-38, epic NOS-3 segment 3.4). Phase A (this file):
// dependency + runner config only. Specs live under e2e/ and are owned by
// qa-engineer (.agents/roles/qa-engineer.md) - this file intentionally
// contains no assertions, only how the suite is run.
//
// Chromium only, on purpose: the ticket scopes this to one engine, and
// `npx playwright install chromium` (not `playwright install`) is what keeps
// CI from ever downloading webkit/firefox binaries it will never use.

const PORT = 4310;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "e2e",

  // Keep this suite out of `npm test`/`npm run verify`: those must stay
  // Docker- and browser-free (see vitest.config.ts's comment on the same
  // constraint for the integration suite, NOS-29). This file is read only by
  // `npm run test:e2e` (playwright test), never by vitest - tsconfig.json
  // still type-checks everything under e2e/**/*.ts via `tsc --noEmit`, which
  // is why @playwright/test is a real devDependency rather than an on-demand
  // `npx playwright install`-style dependency: without its types in
  // node_modules, `npm run verify`'s typecheck stage would fail.
  fullyParallel: true,
  forbidOnly: !!process.env.CI,

  // Advisory-friendly: retry once on CI to absorb a one-off network/timing
  // blip without masking a real failure (no retries locally, so a failure
  // reproduces on the first try). No fixed waits anywhere in this config -
  // flakiness gets fixed in the spec, not papered over here.
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,

  // list: readable console output while watching a run. html: a static,
  // diagnosable artifact for a CI failure, written but never auto-opened (a
  // CI runner has no browser to open it in, and opening one would hang the
  // job). Neither reporter uploads anywhere by itself - that's for the CI
  // workflow (Phase B) to decide, e.g. actions/upload-artifact.
  reporter: [["list"], ["html", { open: "never" }]],

  use: {
    baseURL: BASE_URL,
    // Trace/screenshot/video only on the failing attempt's retry, so a
    // passing run costs nothing extra and a failing one is still
    // diagnosable without re-running by hand.
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "off",
  },

  // Two viewports x two colour schemes = the matrix the ticket asks for.
  // `colorScheme` drives `prefers-color-scheme`, which is the mechanism this
  // config controls. The app also honours a `data-theme` attribute that
  // ThemeToggle.tsx stamps on <html> from localStorage - asserting against
  // that toggle (and against prefers-color-scheme actually taking effect
  // when no override is stored) is qa's job in the specs, not this config's.
  //
  // No storageState is configured anywhere in this file, and Playwright
  // gives every test its own fresh browser context by default (not a shared,
  // persistent profile) - so there is no mechanism here by which a
  // `nostavel:theme` value written by one test's localStorage could survive
  // into the next test or the next project. If a future spec ever adds
  // `storageState` or a persistent `userDataDir`, it must not point at a
  // path shared across these four projects, or that guarantee breaks.
  projects: [
    {
      name: "mobile-light",
      use: { browserName: "chromium", viewport: { width: 375, height: 667 }, colorScheme: "light" },
    },
    {
      name: "mobile-dark",
      use: { browserName: "chromium", viewport: { width: 375, height: 667 }, colorScheme: "dark" },
    },
    {
      name: "desktop-light",
      use: { browserName: "chromium", viewport: { width: 1280, height: 800 }, colorScheme: "light" },
    },
    {
      name: "desktop-dark",
      use: { browserName: "chromium", viewport: { width: 1280, height: 800 }, colorScheme: "dark" },
    },
  ],

  // `next build && next start`, not `next dev`, for two reasons:
  //  1. Production parity - a smoke test exists to catch what ships, and
  //     `next start` is what ships. `next dev`'s Turbopack HMR client and
  //     error-overlay inject extra DOM/console noise that would make an
  //     axe-core scan or a console-error assertion report on tooling, not
  //     the page.
  //  2. `next build` is already proven secret-free: .github/workflows/ci.yml's
  //     own `build` job runs it with no credentials (its header comment: the
  //     database client connects on first query, not on import), and the
  //     four pages this suite targets (/about, /how-it-works, /terms,
  //     /support) touch neither the database nor the supplier API. So this
  //     webServer needs nothing CI doesn't already have.
  // Port 4310 is arbitrary and only needs to not collide with `next dev`'s
  // default 3000.
  webServer: {
    command: `npx next build && npx next start -p ${PORT}`,
    url: BASE_URL,
    // Always false, even locally - NOT !process.env.CI. Reproduced directly
    // (NOS-38 Phase B) what caused two independent unexplained runs to fail
    // with a wall of ERR_CONNECTION_REFUSED (30/176 on this branch, 21/176 on
    // qa's): `reuseExistingServer: true` lets a run attach to whatever is
    // already listening on :4310 instead of starting its own, and Playwright
    // only starts/owns a server once, at the top of a run - it never notices
    // or restarts one that dies mid-run. An orphaned `next start` left behind
    // by an earlier interrupted local run (Ctrl+C before teardown finishes,
    // a killed terminal, an agent session cut off) is exactly such a
    // half-dead process: the next invocation's readiness probe finds it
    // still responding, reuses it, and then it dies a few tests in -
    // reproduced on purpose by starting a manual `next start`, letting a real
    // `playwright test` run attach to it, then killing that process mid-run:
    // the in-flight request failed with ERR_CONNECTION_RESET and every
    // subsequent test failed with ERR_CONNECTION_REFUSED for the rest of the
    // run, an exact match. Ruled out as the cause: request volume/worker
    // count - a dedicated stress run (workers forced to 12, the full core
    // count, 1100+ concurrent connections) held a stable ~265MB and completed
    // 176/176 cleanly twice. Capping workers would not have fixed this and
    // is not done here. Always starting fresh costs one `next build` (~8s
    // measured on this machine) per run, which is cheap next to a failure
    // mode that reads as the app or the suite being broken when neither is.
    reuseExistingServer: false,
    // A cold `next build` of the whole app, not just the four in-scope
    // pages, can take a while; default Playwright timeout (60s) isn't enough.
    timeout: 180_000,
  },
});
