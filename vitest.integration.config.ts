import { defineConfig } from "vitest/config";
import path from "node:path";

// Config for `npm run test:int` only - never loaded by `npm test` or
// `npm run verify` (vitest.config.ts explicitly excludes src/**/*.int.test.ts;
// see the comment there, NOS-29 AC 2/3). These tests run drizzle-orm/neon-http
// (src/db/index.ts) against a real Postgres, reached through a local Neon HTTP
// proxy (compose.test.yml) - db.batch's single-transaction guarantee is
// specific to that driver and can't be proven against a mock or a different
// driver (e.g. node-postgres), which is the reason this suite exists.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.int.test.ts"],
    // Integration tests share one containerised Postgres, reached over HTTP.
    // Running test files in parallel workers races writes and reads against
    // the same tables - most sharply the append-only booking_events ledger
    // (.claude/rules/database.md) - and turns into flaky, run-order-dependent
    // failures. Serial files trade suite speed for a check that is actually
    // deterministic, which matters more for something that gates CI.
    fileParallelism: false,
    // Runs once, before any test file, in its own process with no shared
    // memory with the tests (Vitest's `globalSetup`, unlike `setupFiles`, is
    // isolated) - the right place for the one-time side effect of applying
    // migrations to the database compose.test.yml just started.
    globalSetup: ["./scripts/test-int-migrate.mjs"],
    // Runs inside each test file's own context, so it can mutate the
    // `neonConfig` singleton that `@neondatabase/serverless` reads when
    // src/db/index.ts later constructs its client. `globalSetup` can't do
    // this: it shares no memory with the test files that actually run
    // queries.
    setupFiles: ["./scripts/test-int-neon-setup.mjs"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Same reasoning as vitest.config.ts: tests run in plain Node, not
      // Next's webpack build, so swap in the no-op RSC build.
      "server-only": path.resolve(__dirname, "./node_modules/server-only/empty.js"),
    },
  },
});
