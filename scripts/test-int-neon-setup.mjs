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
import { assertLocalFetchEndpoint, assertLocalTestTarget } from "./test-int-target.mjs";

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

// NOS-34 DEFECT 2 (safety): this is the leg the queries actually travel -
// @neondatabase/serverless sends DATABASE_URL, just validated above, as a
// "Neon-Connection-String" HTTP header to whatever fetchEndpoint names (see
// assertLocalFetchEndpoint's comment in test-int-target.mjs for where that's
// confirmed in the driver's own source). Set by scripts/test-int.mjs; falls
// back to the proxy's default compose port so this file also works if a test
// file config imports it directly. Compute the effective value first and
// validate THAT - including the default - before it is ever assigned to
// neonConfig, so a bad NEON_PROXY_URL can never be installed on the driver.
const fetchEndpoint = process.env.NEON_PROXY_URL ?? "http://localhost:4444/sql";
assertLocalFetchEndpoint(fetchEndpoint, {
  source: "NEON_PROXY_URL (or its default), checked by scripts/test-int-neon-setup.mjs before " +
    "neonConfig.fetchEndpoint is set",
});

neonConfig.fetchEndpoint = fetchEndpoint;
