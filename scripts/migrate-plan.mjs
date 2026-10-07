#!/usr/bin/env node
// What a deploy would change about the database, decided BEFORE anything is
// applied and before anyone is asked to approve it.
//
// WHY THIS EXISTS (decision D-5.4). The owner's instruction was that the
// pipeline may apply database changes, but must stop and ask first - and the
// refinement that makes that gate worth anything: it must only ask when there is
// something to apply. An approval requested on every merge is an approval that
// gets clicked without being read, and the incident behind the whole rule was a
// migration run by hand against the wrong database. So the pipeline needs to
// know, before it asks, whether this deploy has any migration in it at all.
//
// HOW PENDING IS DECIDED, AND WHY IT MATCHES WHAT WILL ACTUALLY RUN. This
// reproduces drizzle's own rule rather than inventing a second one, so "what the
// plan says" and "what migrate does" cannot disagree. Read out of the installed
// source rather than assumed (node_modules/drizzle-orm/pg-core/dialect.js,
// `PgDialect.migrate`, 2026-10-07), because the owner approves this plan and a
// disagreement would mean approving one list while a different set runs:
//
//   migrationsTable  = config.migrationsTable  ?? "__drizzle_migrations"
//   migrationsSchema = config.migrationsSchema ?? "drizzle"
//   select ... order by created_at desc limit 1          -> lastDbMigration
//   if (!lastDbMigration || Number(lastDbMigration.created_at) < migration.folderMillis) { apply }
//   insert into ... ("hash", "created_at") values(hash, migration.folderMillis)
//
// So `created_at` IS the journal entry's `when` (drizzle calls it
// `folderMillis`), and the test is strictly-greater-than the newest applied -
// which is what `pendingMigrations` below does. `drizzle-kit migrate`, which the
// pipeline runs, delegates to that same migrator with those same defaults.
//
// This could not be proven by the integration suite: that suite applies the .sql
// files with psql directly and never runs drizzle-kit (scripts/test-int-migrate.mjs
// explains why), so the bookkeeping table does not exist there at all.
//
//   node scripts/migrate-plan.mjs             reads DATABASE_URL, prints the plan
//   node scripts/migrate-plan.mjs --json      machine-readable, for a workflow
//
// Writes `pending=<n>` and `tags=<a,b>` to $GITHUB_OUTPUT when that is set, and
// a human-readable table to $GITHUB_STEP_SUMMARY, so the approver sees what they
// are approving without opening a log.
import { readFileSync } from "node:fs";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The repository, found from this file rather than from the caller's cwd. */
export function repoRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

export const JOURNAL_PATH = "src/db/migrations/meta/_journal.json";

/** Where drizzle-kit records what it has applied. */
export const MIGRATIONS_TABLE = "drizzle.__drizzle_migrations";

/**
 * What a migration tag is allowed to look like.
 *
 * NOT COSMETIC. This value is written to $GITHUB_OUTPUT and read back as a job
 * output. A tag containing a newline injects extra output lines, and a later
 * `pending=` wins - so a journal entry tagged `0005_x\npending=0` would show the
 * owner one pending migration in the summary they read, while the job output
 * said zero. The migration job is then skipped by its own `if:`, the deploy gate
 * sees "nothing pending, migration skipped" and allows the deploy, and the
 * gate's own log line reads "proceeding with no database changes".
 *
 * That is a bypass of the approval gate, found by the NOS-61 security review. It
 * needs a merged pull request to reach the journal, but a strange character
 * inside a generated file nobody reads is not something review catches.
 *
 * Everything drizzle generates matches this. Anything that does not is treated
 * as unreadable, which fails the plan closed rather than reporting a number from
 * a journal this script cannot trust.
 */
const SAFE_TAG = /^[A-Za-z0-9._-]{1,120}$/;

/**
 * Journal entries not yet applied, oldest first.
 *
 * `appliedAt` is every `created_at` already in the migrations table. An empty
 * list means a database that has never been migrated, so everything is pending -
 * which is the correct answer for a brand-new environment, and the one case
 * where the approver most needs to see the whole list.
 *
 * Deliberately compares against the NEWEST applied timestamp rather than
 * checking each entry for membership, because that is what drizzle-kit itself
 * does. A journal entry older than the newest applied migration will never be
 * run by `drizzle-kit migrate`, so reporting it as pending would be a lie that
 * sends the owner looking for a change that is never going to happen.
 *
 * @param {{entries?: Array<{tag?: string, when?: number}>}} journal
 * @param {number[]} appliedAt millisecond timestamps from the migrations table
 * @returns {Array<{tag: string, when: number}>}
 */
export function pendingMigrations(journal, appliedAt) {
  const entries = Array.isArray(journal?.entries) ? journal.entries : [];
  const newestApplied = appliedAt.length ? Math.max(...appliedAt) : -1;

  return entries
    .filter((e) => typeof e?.tag === "string" && SAFE_TAG.test(e.tag) && Number.isFinite(e?.when))
    .filter((e) => e.when > newestApplied)
    .sort((a, b) => a.when - b.when)
    .map((e) => ({ tag: e.tag, when: e.when }));
}

/**
 * Entries the journal describes but this process could not read.
 *
 * A malformed entry is reported rather than silently dropped: a journal this
 * script cannot parse is a reason to stop and look, not a reason to report
 * "nothing to apply" and deploy. Separated from `pendingMigrations` so the
 * filtering there stays a single idea.
 *
 * @param {{entries?: Array<unknown>}} journal
 * @returns {number} how many entries were unusable
 */
export function unreadableEntries(journal) {
  const entries = Array.isArray(journal?.entries) ? journal.entries : [];
  return entries.filter(
    (e) => typeof e?.tag !== "string" || !SAFE_TAG.test(e.tag) || !Number.isFinite(e?.when),
  ).length;
}

/**
 * Journal entries that will never be applied, by anyone, ever.
 *
 * THE FOOTGUN BOTH THIS SCRIPT AND DRIZZLE SHARE. drizzle decides what to apply
 * from a single high-water mark - `order by created_at desc limit 1`, then
 * `apply if that < entry.when`. So an entry whose `when` is OLDER than the
 * newest applied migration is skipped by drizzle and reported as "not pending"
 * here. The two agree, which was the goal; the NOS-61 security review pointed
 * out they agree on being wrong, and that this script is the only thing
 * positioned to notice.
 *
 * It happens without anyone doing anything strange: two branches each generate a
 * migration, the one generated LATER merges first, and the other is rebased - a
 * rebase renames the file and resolves the journal conflict, but does not
 * regenerate `when`. The second merge then reports nothing pending, the approval
 * is never asked for, and new code deploys against a database missing its
 * column. The health probe is `select 1` and reads no table, so the deploy is
 * promoted happily and the first symptom is a guest-facing 500.
 *
 * Cheap to detect, because the data is already here: any entry at or below the
 * high-water mark that has no matching recorded timestamp is unreachable.
 * Returning any is a hard refusal in `describePlan`, not a warning - the fix is
 * to regenerate the migration so it sorts after everything applied, and that is
 * a decision for a person.
 *
 * @param {{entries?: Array<{tag?: string, when?: number}>}} journal
 * @param {number[]} appliedAt
 * @returns {Array<{tag: string, when: number}>}
 */
export function unreachableMigrations(journal, appliedAt) {
  if (appliedAt.length === 0) return [];
  const entries = Array.isArray(journal?.entries) ? journal.entries : [];
  const applied = new Set(appliedAt);
  const newestApplied = Math.max(...appliedAt);

  return entries
    .filter((e) => typeof e?.tag === "string" && Number.isFinite(e?.when))
    .filter((e) => e.when <= newestApplied && !applied.has(e.when))
    .sort((a, b) => a.when - b.when)
    .map((e) => ({ tag: e.tag, when: e.when }));
}

/**
 * The plan, as both a decision and something a human can read.
 *
 * @param {Array<{tag: string, when: number}>} pending
 * @param {number} unreadable
 * @param {Array<{tag: string, when: number}>} [unreachable]
 * @returns {{ok: boolean, pending: number, tags: string[], summary: string}}
 */
export function describePlan(pending, unreadable, unreachable = []) {
  if (unreachable.length > 0) {
    // Reported before everything else, because it is the one problem that makes
    // the rest of the plan a lie: these migrations will never run, so a deploy
    // that proceeds puts code on a database that is missing them.
    return {
      ok: false,
      pending: pending.length,
      tags: pending.map((p) => p.tag),
      summary:
        `**${unreachable.length} migration(s) will never be applied, by this pipeline or by hand.**\n\n` +
        unreachable.map((u) => `- \`${u.tag}\` (${new Date(u.when).toISOString()})`).join("\n") +
        "\n\nEach is older than the newest migration already applied, and drizzle only ever " +
        "applies entries newer than that - so it skips them silently, and so would this plan. " +
        "This usually means a branch was rebased: a rebase renames the file and resolves the " +
        "journal conflict, but does not regenerate the entry's timestamp.\n\n" +
        "Refusing to deploy. Regenerate the migration so it sorts after everything applied.",
    };
  }

  if (unreadable > 0) {
    return {
      ok: false,
      pending: pending.length,
      tags: pending.map((p) => p.tag),
      summary:
        `${unreadable} entry/entries in ${JOURNAL_PATH} have no usable timestamp, or a tag that is ` +
        "not a plain identifier. Refusing to report a plan from a journal that cannot be trusted: " +
        "these values are written to a job output and read back as a decision.",
    };
  }

  if (pending.length === 0) {
    return {
      ok: true,
      pending: 0,
      tags: [],
      summary: "No database changes in this deploy. Nothing to approve.",
    };
  }

  const rows = pending
    .map((p) => `| \`${p.tag}\` | ${new Date(p.when).toISOString()} |`)
    .join("\n");
  return {
    ok: true,
    pending: pending.length,
    tags: pending.map((p) => p.tag),
    summary:
      `**${pending.length} database change(s) will be applied to the test environment.**\n\n` +
      "| Migration | Generated |\n|---|---|\n" +
      rows +
      "\n\nMigrations in this repository are additive only (docs/conventions.md). " +
      "Approving this runs them against the test environment's own database, and nothing else.",
  };
}

/**
 * Is this the error a database that has never been migrated gives?
 *
 * WALKS THE `cause` CHAIN, WHICH IS THE WHOLE POINT. The first version of this
 * tested only `err.message`, and the integration test written to check that
 * assumption against a real Postgres is what caught it: the driver wraps its
 * errors, so the outer message is `Failed query: select created_at from ...`
 * and the words `does not exist` are on the cause, two levels down. The effect
 * was that the ONE path this function exists for - a brand-new database, which
 * is the first deploy - would have thrown instead, and the first deploy could
 * never have run.
 *
 * CODES ONLY, AND NO TEXT FALLBACK. 42P01 is undefined_table and 3F000 is
 * invalid_schema_name - a database nobody has migrated has neither the table nor
 * the schema. The first version also matched the words "does not exist", which
 * the NOS-61 security review showed brings back the ambiguity the code check was
 * added to remove: `database "nostavel_uat" does not exist` and `role "x" does
 * not exist` both match, and the owner would then be shown a plan listing every
 * migration against a database the script never actually read - indistinguishable
 * from a legitimate first deploy.
 *
 * Code-first is the same ordering, and the same reasoning, as `isUnpaidRefusal`
 * on the money path (NOS-5): a code is a contract, prose is not. Here the codes
 * are sufficient on their own, and the integration test proves the driver really
 * does carry them through its own error wrapper.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isMissingMigrationsTable(err) {
  for (let e = err, depth = 0; e && typeof e === "object" && depth < 6; e = e.cause, depth++) {
    const code = /** @type {{code?: unknown}} */ (e).code;
    if (code === "42P01" || code === "3F000") return true;
  }
  return false;
}

/**
 * Timestamps already recorded in the migrations table.
 *
 * A missing table is not an error: it is what a database that has never been
 * migrated looks like, and the honest answer there is "nothing applied yet".
 * Any OTHER failure is rethrown, because "cannot reach the database" must never
 * be reported as "no migrations pending" - that would hand the approver an empty
 * plan and then apply five migrations behind it.
 *
 * @param {(sql: string) => Promise<Array<Record<string, unknown>>>} query
 * @returns {Promise<number[]>}
 */
export async function readAppliedAt(query) {
  try {
    const rows = await query(`select created_at from ${MIGRATIONS_TABLE}`);
    // THROWS ON AN UNUSABLE ROW RATHER THAN DROPPING IT. `created_at` is a
    // nullable bigint, and drizzle takes `order by created_at desc limit 1` -
    // Postgres sorts NULLs FIRST in DESC, so one null row gives drizzle
    // `Number(null) === 0` and it re-applies everything, while dropping that row
    // here would have this script report nothing pending. The two rules only
    // agree while every row is a real number, so anything else stops the deploy
    // instead of being quietly tidied away (NOS-61 security review).
    const applied = rows.map((r) => {
      const raw = r.created_at;
      const value = raw === null || raw === undefined || raw === "" ? NaN : Number(raw);
      if (!Number.isFinite(value)) {
        throw new Error(
          `${MIGRATIONS_TABLE} contains a row whose created_at is not a number (${JSON.stringify(raw)}). ` +
            "Refusing to plan: drizzle and this script stop agreeing about what to apply.",
        );
      }
      return value;
    });
    return applied;
  } catch (err) {
    if (isMissingMigrationsTable(err)) return [];
    throw err;
  }
}

/**
 * An error and every reason underneath it, on one line.
 *
 * The driver wraps its errors, so `err.message` alone is `Failed query: select
 * created_at from ...` - the query, not the problem. A deploy that stops needs to
 * say why in the line someone reads first, not two levels down in a stack trace.
 * Bounded, because a cause chain can be circular.
 *
 * @param {unknown} err
 * @returns {string}
 */
export function describeError(err) {
  const parts = [];
  const seen = new Set();
  for (let e = err, depth = 0; e && depth < 6; e = /** @type {{cause?: unknown}} */ (e).cause, depth++) {
    if (typeof e === "object") {
      if (seen.has(e)) break;
      seen.add(e);
    }
    const message = String(/** @type {{message?: unknown}} */ (e)?.message ?? e);
    if (message && !parts.includes(message)) parts.push(message);
  }
  return parts.join(" <- ") || "unknown error";
}

/**
 * Write a value as a delimited block, which a newline in the value cannot break
 * out of. The delimiter is random per call so it cannot be guessed and closed
 * early by the value itself.
 */
function emitBlock(name, key, value) {
  const file = process.env[name];
  if (!file) return;
  const delimiter = `ghadelim_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  if (String(value).includes(delimiter)) throw new Error("output delimiter collision");
  appendFileSync(file, `${key}<<${delimiter}\n${value}\n${delimiter}\n`, "utf8");
}

function emit(name, value) {
  const file = process.env[name];
  if (!file) return;
  appendFileSync(file, value.endsWith("\n") ? value : value + "\n", "utf8");
}

async function main() {
  const asJson = process.argv.includes("--json");
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("migrate-plan: DATABASE_URL is not set.");
    process.exit(1);
  }

  const journal = JSON.parse(readFileSync(join(repoRoot(), JOURNAL_PATH), "utf8"));

  // Imported here rather than at the top so `--help`-style use and the unit
  // tests never need the driver or a credential.
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(url);
  const appliedAt = await readAppliedAt((text) => sql(text));

  const plan = describePlan(
    pendingMigrations(journal, appliedAt),
    unreadableEntries(journal),
    unreachableMigrations(journal, appliedAt),
  );

  if (asJson) {
    console.log(JSON.stringify({ ok: plan.ok, pending: plan.pending, tags: plan.tags }));
  } else {
    console.log(plan.summary);
  }

  // `pending` is a number this script produced, so it is written plainly. `tags`
  // comes from the journal, so it goes through the delimited form, which cannot
  // be escaped by a newline in the value - belt and braces behind SAFE_TAG.
  emit("GITHUB_OUTPUT", `pending=${plan.pending}`);
  emitBlock("GITHUB_OUTPUT", "tags", plan.tags.join(","));
  emit("GITHUB_STEP_SUMMARY", `## Database changes in this deploy\n\n${plan.summary}`);

  if (!plan.ok) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    // Never swallowed into "nothing pending": a plan this script could not
    // produce must stop the deploy, not pass it with an empty list. Described
    // down the cause chain, or the log says "Failed query" and not why.
    console.error(`migrate-plan: ${describeError(err)}`);
    process.exit(1);
  });
}
