// Single choke point every entry point into the integration suite goes
// through before it can touch a database at all.
//
// NOS-29 incident this exists to make impossible, not just unlikely: the
// owner ran `npx vitest list --config vitest.integration.config.ts` by
// hand - a normal, reasonable way to explore a Vitest config - which skips
// scripts/test-int.mjs, the only thing that otherwise sets DATABASE_URL to
// the local throwaway container. Without it, the old migration step
// (`drizzle-kit migrate`, via scripts/test-int-migrate.mjs's globalSetup)
// loaded drizzle.config.ts, which falls back to `.env.local` whenever
// DATABASE_URL isn't already set - and `.env.local` holds the owner's REAL
// PRODUCTION Neon connection string. Migrations were applied against
// production. It was a no-op only because every migration was already
// applied there; the next migration run this way would not have been.
//
// "Remember to always go through npm run test:int" is not a fix - it relies
// on nobody ever taking the obvious, direct path into the tool again. The
// actual fix is making every other target impossible to reach from this
// suite, no matter how it's invoked: scripts/test-int-migrate.mjs (the
// migration step) and vitest.integration.config.ts's `globalSetup` and
// `setupFiles` (the test run itself) all call assertLocalTestTarget() below
// before doing anything else - so entering via `npm run test:int`,
// `npx vitest run --config vitest.integration.config.ts`, or a single test
// file all refuse the same way.
//
// The only target this suite ever accepts: the postgres service
// compose.test.yml starts, reached on the port it PUBLISHES to the host
// (not the in-network port neon-proxy uses to reach it) as the `main`
// database. See compose.test.yml's `ports:` and `POSTGRES_DB` entries.

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);
const EXPECTED_PORT = "55432"; // compose.test.yml: postgres's `ports: ["55432:5432"]` (host side)
const EXPECTED_DATABASE = "main"; // compose.test.yml: postgres's `POSTGRES_DB: main`

/**
 * Never returns (or lets a caller log) a whole connection string, and never
 * the password - a Neon connection string's *username* is also
 * project-specific and worth keeping out of logs, so only host, port and
 * database name are ever surfaced.
 */
function describe(rawValue) {
  try {
    const url = new URL(rawValue);
    const host = url.hostname || "(empty)";
    const port = url.port || "(default)";
    const database = url.pathname.replace(/^\//, "") || "(empty)";
    return `host=${host} port=${port} database=${database}`;
  } catch {
    return "(could not be parsed as a connection URL)";
  }
}

/**
 * Throws unless `rawValue` is a connection string that can only reach the
 * throwaway container compose.test.yml starts. `source` is folded into the
 * error message so a refusal names where the bad value came from (an env
 * var, a hardcoded fallback, ...), which matters once more than one caller
 * shares this function.
 *
 * Deliberately strict rather than clever: this does not try to detect "is
 * this a Neon host" (an allow-list would have to know every possible Neon
 * hostname pattern forever); it only ever allows the one specific target
 * this suite is meant to run against, and refuses everything else,
 * including a typo'd local port this suite doesn't actually use.
 */
export function assertLocalTestTarget(rawValue, { source } = {}) {
  const from = source ? ` (from ${source})` : "";

  if (!rawValue) {
    throw new Error(
      `Integration suite refused to run: no DATABASE_URL was set${from}. ` +
        `This suite only ever targets the throwaway Postgres container in ` +
        `compose.test.yml, started and pointed at by "npm run test:int". It ` +
        `never falls back to .env.local or anything else - that file holds ` +
        `a real production database URL. Run "npm run test:int" instead of ` +
        `invoking vitest directly.`,
    );
  }

  let url;
  try {
    url = new URL(rawValue);
  } catch {
    throw new Error(
      `Integration suite refused to run: DATABASE_URL${from} could not be parsed as a ` +
        `connection URL. Refusing rather than guessing what it points at.`,
    );
  }

  const host = url.hostname;
  const port = url.port || "5432"; // postgres:// with no explicit port means 5432
  const database = url.pathname.replace(/^\//, "");
  const seen = describe(rawValue);

  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `Integration suite refused to run: DATABASE_URL${from} is not the local test ` +
        `container. Saw ${seen}; expected host "localhost" or "127.0.0.1". This suite ` +
        `never runs against a remote database, production or otherwise.`,
    );
  }
  if (port !== EXPECTED_PORT) {
    throw new Error(
      `Integration suite refused to run: DATABASE_URL${from} is not the local test ` +
        `container. Saw ${seen}; expected port "${EXPECTED_PORT}" (the port ` +
        `compose.test.yml publishes postgres on).`,
    );
  }
  if (database !== EXPECTED_DATABASE) {
    throw new Error(
      `Integration suite refused to run: DATABASE_URL${from} is not the local test ` +
        `container. Saw ${seen}; expected database "${EXPECTED_DATABASE}" ` +
        `(compose.test.yml's POSTGRES_DB).`,
    );
  }
}
