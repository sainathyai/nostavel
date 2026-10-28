import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Exploratory/measurement scripts (docs/conventions.md section 8) — kept
    // as provenance for constants elsewhere in the app, not held to product
    // code's lint bar. This was previously tolerated locally (nobody checked
    // `npm run lint`'s exit code) but broke CI, which does.
    "analysis/**",
    // Vendored verbatim from node_modules/maplibre-gl/dist — see the long
    // comment in components/map-style.ts for why these two files exist as
    // static assets. Not authored code; must not be linted or reformatted.
    "public/maplibre-gl-worker.mjs",
    "public/maplibre-gl-shared.mjs",
  ]),
  {
    // liteapi.ts parses LiteAPI's own JSON responses (hotel/rate/booking
    // shapes), which are untyped at the boundary — `any` there is real,
    // acknowledged debt, not an oversight. Downgraded to a warning (not
    // silenced) so CI can pass without hiding the count: `npm run lint`
    // still reports every instance, it just no longer fails the build.
    // Properly typing this belongs with the zod-validation work already
    // planned for Phase 4 of docs/production-readiness.md, where response
    // shapes get validated at runtime rather than hand-typed and left to
    // drift from what LiteAPI actually sends.
    files: ["src/lib/liteapi.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "warn" },
  },
  {
    // ONE LOG SHAPE (NOS-69). A `console.log` in application code is a line no
    // metric can count, no filter can find and no alert can be built on, and
    // the twenty-one that existed are why NOS-56 had nothing to key on. The
    // logger in src/lib/log.ts writes JSON with `severity`, `event` and
    // `message`; use it.
    //
    // Tests are not listed: they assert on what a logger WROTE, which means
    // spying on console, and a test's own output is nobody's monitoring.
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "src/**/*.int.test.ts",
      // The logger itself, which is the one place allowed to call console: it
      // routes ERROR and CRITICAL to stderr and the rest to stdout, so the
      // stream still agrees with the payload for anything that does not parse
      // JSON (a local terminal, `docker logs`).
      "src/lib/log.ts",
    ],
    rules: {
      // No `allow` list: every method, including `console.error`. An error that
      // is only a string is as unfindable as an info line that is only a string.
      "no-console": "error",
    },
  },
]);

export default eslintConfig;
