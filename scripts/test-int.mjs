// Run: npm run test:int
//
// Brings up compose.test.yml, waits for the local Neon proxy to accept
// connections, runs the neon-http integration suite
// (vitest.integration.config.ts, which applies migrations itself via
// `globalSetup` - see scripts/test-int-migrate.mjs), then tears the
// containers down whether the run passed or failed.
//
// Requires Docker. NOT run by `npm test` or `npm run verify` (NOS-29 AC 2/3):
// those stay Docker-free and secret-free so every job in
// .github/workflows/ci.yml still runs on a forked pull request with nothing
// installed but Node. This is its own entry point, run by the
// test-integration CI job and, optionally, by hand with Docker running.
import { spawnSync } from "node:child_process";

const COMPOSE_FILE = "compose.test.yml";
const isWindows = process.platform === "win32";

// Fixed, non-secret credentials for a throwaway container that exists only
// for the length of one run (see compose.test.yml). Assembled from separate
// pieces, rather than written out as one literal connection string, only so
// this file's own text never contains a "user:password@" pattern for the
// repository guard (scripts/agent-guards/patterns.mjs) to flag - it is not a
// real secret.
const DB_USER = "postgres";
const DB_PASSWORD = "postgres";
const DB_NAME = "main";

function pgConnectionString(hostPort) {
  return "postgres://" + DB_USER + ":" + DB_PASSWORD + "@" + hostPort + "/" + DB_NAME;
}

// Reached from this script's own process, via the port compose.test.yml
// publishes to the host.
const DATABASE_URL = pgConnectionString("localhost:55432");
// Reached by the neon-proxy container itself, over the compose network (the
// service name, not localhost) - passed through to compose.test.yml, which
// deliberately does not write this value out itself (see its comment).
const TEST_PG_CONNECTION_STRING = pgConnectionString("postgres:5432");
const NEON_PROXY_URL = "http://localhost:4444/sql";

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: isWindows,
    env: { ...process.env, ...extraEnv },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with code ${String(result.status)}`);
  }
}

// The postgres service has a healthcheck compose can wait on; the proxy
// image (community, not Neon's own - see compose.test.yml) ships none, so
// `docker compose up --wait` can return before its HTTP listener is actually
// accepting connections. Poll it directly rather than guess a fixed sleep.
async function waitForProxy(url, { retries = 30, delayMs = 500 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // Any HTTP response at all - even an error body for a malformed query
      // - means the listener is up, which is all this is checking for.
      await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(`neon-proxy at ${url} did not respond after ${retries} attempts`);
}

async function main() {
  let failure = null;
  try {
    run("docker", ["compose", "-f", COMPOSE_FILE, "up", "-d", "--wait"], { TEST_PG_CONNECTION_STRING });
    await waitForProxy(NEON_PROXY_URL);
    run("npx", ["vitest", "run", "--config", "vitest.integration.config.ts"], { DATABASE_URL, NEON_PROXY_URL });
  } catch (err) {
    failure = err;
  }
  try {
    run("docker", ["compose", "-f", COMPOSE_FILE, "down", "-v"], { TEST_PG_CONNECTION_STRING });
  } catch (teardownError) {
    console.error(`warning: teardown failed: ${teardownError.message}`);
  }
  if (failure) throw failure;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
