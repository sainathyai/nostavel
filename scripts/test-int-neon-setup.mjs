// Vitest `setupFiles` entry for the integration suite
// (vitest.integration.config.ts). Runs inside each test file's own context -
// unlike `globalSetup` (scripts/test-int-migrate.mjs), which is isolated and
// shares no memory with the tests - which is what lets this mutate the
// `neonConfig` singleton that `@neondatabase/serverless` reads when
// src/db/index.ts later constructs its `neon()` client.
//
// Points the driver's HTTP client at the local Neon proxy started by
// compose.test.yml (see that file's comment on TimoWilhelm/local-neon-http-proxy)
// instead of a real Neon endpoint. Kept out of src/db/index.ts on purpose:
// production code must never know a local proxy exists.
import { neonConfig } from "@neondatabase/serverless";
import { assertLocalTestTarget } from "./test-int-target.mjs";

// NOS-29 DEFECT 1 (safety): `setupFiles` runs inside each test file's own
// process, separately from `globalSetup` (scripts/test-int-migrate.mjs),
// which already refuses before applying migrations - but that isolation
// cuts both ways: nothing stops a future test file, or a future Vitest
// config, from wiring this file in without that globalSetup ever running.
// Checking again here, right before the test process's own DB client gets
// pointed anywhere, means no *.int.test.ts file can ever run its queries
// against a non-local target either, independent of how it was launched.
assertLocalTestTarget(process.env.DATABASE_URL, {
  source: "process.env.DATABASE_URL, checked by scripts/test-int-neon-setup.mjs before any test file runs",
});

// Set by scripts/test-int.mjs. Falls back to the proxy's default compose
// port so this file also works if a test file config imports it directly.
neonConfig.fetchEndpoint = process.env.NEON_PROXY_URL ?? "http://localhost:4444/sql";
