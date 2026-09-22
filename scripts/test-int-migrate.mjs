// Vitest `globalSetup` for the integration suite (vitest.integration.config.ts).
// Runs once, before any src/**/*.int.test.ts file, in its own process -
// `globalSetup` shares no module state with the test files themselves, which
// makes it the right place for a one-time side effect like applying
// migrations, and the wrong place for anything a test needs to read back
// (that wiring is scripts/test-int-neon-setup.mjs, loaded as `setupFiles`
// instead, which does share context with the tests).
//
// NOS-29 DEFECT 2: this used to shell out to `drizzle-kit migrate`. Against
// compose.test.yml's plain local Postgres, drizzle-kit selects the
// @neondatabase/serverless driver and can only reach it over a websocket
// (it warned as much, and applied nothing) - the suite was reporting green
// while every test ran against a database with no tables at all. Replaced
// below with a driver-free path that needs no new dependency: every .sql
// file this repo already committed to src/db/migrations, applied in the
// order src/db/migrations/meta/_journal.json records, piped straight into
// `psql` running INSIDE the postgres container itself (`docker compose
// exec`) - so this exercises this repo's own migration files exactly as
// committed, the same files a real deploy applies, not a schema re-derived
// from src/db/schema.ts.
//
// NOS-29 DEFECT 1 (safety - read this before touching this file): the very
// first thing this function does is assertLocalTestTarget()
// (scripts/test-int-target.mjs). Unlike the old drizzle-kit path, nothing
// here ever loads drizzle.config.ts or touches .env.local - there is now no
// code path by which this migration step can even see the owner's
// production database URL, let alone apply anything to it. Do not
// reintroduce drizzle-kit (or anything else that reads drizzle.config.ts)
// into this file.
//
// Assumption this script relies on: it runs against a freshly created
// container. compose.test.yml has no volume that survives `docker compose
// down -v` (scripts/test-int.mjs's teardown runs that on every exit, pass
// or fail), so there is never a previously-migrated database to reconcile
// against - each run applies every migration to a genuinely empty `main`
// database. This is deliberately NOT idempotent: re-running it by hand
// against a container that's still up from a previous run fails on the
// first `CREATE TABLE` (no `IF NOT EXISTS` - matching what a real deploy's
// migration runner does). If you need to re-run this against a container
// still up from a previous attempt, tear it down first:
// `docker compose -f compose.test.yml down -v`.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertLocalTestTarget } from "./test-int-target.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "../src/db/migrations");
const COMPOSE_FILE = "compose.test.yml";
const isWindows = process.platform === "win32";

/** Migration tags in the order src/db/migrations/meta/_journal.json records - the same order drizzle-kit itself would apply them in. */
function migrationTagsInOrder() {
  const journalPath = path.join(MIGRATIONS_DIR, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  return [...journal.entries].sort((a, b) => a.idx - b.idx).map((entry) => entry.tag);
}

export default function setup() {
  // DATABASE_URL is set by scripts/test-int.mjs on the environment before it
  // spawns vitest, so it is already in process.env here when this suite is
  // entered the supported way (`npm run test:int`). Refuse loudly for any
  // other value, including none at all - see scripts/test-int-target.mjs
  // for exactly why this has to be a hard failure, never a fallback.
  assertLocalTestTarget(process.env.DATABASE_URL, {
    source: "process.env.DATABASE_URL, checked by scripts/test-int-migrate.mjs before applying any migration",
  });

  for (const tag of migrationTagsInOrder()) {
    const sqlPath = path.join(MIGRATIONS_DIR, `${tag}.sql`);
    const sql = readFileSync(sqlPath, "utf8");
    // drizzle-kit writes `--> statement-breakpoint` between statements as
    // its own marker for drivers that can only run one statement per call
    // (like the neon-http driver src/db/index.ts uses in production). It is
    // not special syntax: `--` already starts a standard SQL line comment,
    // so postgres (and therefore psql) ignores the whole line on its own.
    // Nothing here strips or rewrites it - confirmed by running this script
    // for real against 0000_numerous_dracula.sql, which has several, and
    // seeing every table land (see the pull request for the transcript).
    const result = spawnSync(
      "docker",
      [
        "compose",
        "-f",
        COMPOSE_FILE,
        "exec",
        "-T", // no TTY: this is a piped, non-interactive input, not a session
        "postgres",
        "psql",
        "-U",
        "postgres",
        "-d",
        "main",
        "-v",
        "ON_ERROR_STOP=1", // a partially-applied migration must fail the run, not warn and continue
      ],
      { input: sql, stdio: ["pipe", "inherit", "inherit"], shell: isWindows },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`psql exited with code ${String(result.status)} applying ${tag}.sql`);
    }
  }
}
