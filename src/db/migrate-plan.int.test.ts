// Integration test: proves the deploy pipeline's migration plan against a REAL
// Postgres (vitest.integration.config.ts), not against an assumption.
//
// WHY THIS EXISTS, AND WHAT IT ALREADY CAUGHT. The pipeline asks the owner to
// approve a list of database changes (decision D-5.4), and
// `scripts/migrate-plan.mjs` produces that list. Its unit tests prove the
// arithmetic; they cannot prove the two premises underneath it, both of which
// are claims about software this repository does not own.
//
// The first draft of this file assumed the integration database would already
// have drizzle's bookkeeping table, and it does not: `scripts/test-int-migrate.mjs`
// applies the committed .sql files with `psql` directly and deliberately never
// runs drizzle-kit (its own header explains why). So this file creates that table
// itself and puts the repository's real journal timestamps in it. That is enough
// to prove the query and the comparison against a real database, and it is
// honest about what it is not proving.
//
//   - PROVEN HERE: the SQL is valid; a real driver's rows come back in a shape
//     `readAppliedAt` can read; the plan is empty against a fully recorded
//     database and names exactly the right migration when one is missing; and a
//     missing table is recognised through the driver's OWN error wrapper.
//   - PROVEN BY READING THE INSTALLED SOURCE instead, because no test here can
//     reach it: that drizzle records `created_at` as the journal entry's `when`
//     and applies everything strictly newer than the maximum
//     (node_modules/drizzle-orm/pg-core/dialect.js, `PgDialect.migrate`). The
//     comment on `migrate-plan.mjs` quotes it.
//
// THE DEFECT THIS FOUND. `readAppliedAt` tested `err.message` for "does not
// exist". The real driver throws its own error with the database's underneath, so
// those words are two levels down - and the one path the function exists for, a
// brand-new database, is the first deploy. It would have thrown instead of
// planning every migration. The matcher now walks the cause chain and reads the
// Postgres error code first.
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "@/db";
import {
  JOURNAL_PATH,
  pendingMigrations,
  readAppliedAt,
  repoRoot,
} from "../../scripts/migrate-plan.mjs";

/** The same shape `migrate-plan.mjs` passes in, backed by the real driver. */
async function query(text: string): Promise<Array<Record<string, unknown>>> {
  const result = await db.execute(sql.raw(text));
  // The neon-http driver returns either an array of rows or a result object
  // depending on the statement; both shapes are handled the way the script's
  // own caller would see them.
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as Array<
    Record<string, unknown>
  >;
}

type Journal = { entries: Array<{ tag: string; when: number }> };

function realJournal(): Journal {
  return JSON.parse(readFileSync(join(repoRoot(), JOURNAL_PATH), "utf8")) as Journal;
}

/** Exactly the table drizzle creates, copied from its migrator's own DDL. */
async function createBookkeeping(): Promise<void> {
  await query(`create schema if not exists "drizzle"`);
  await query(
    `create table if not exists "drizzle"."__drizzle_migrations" (
       id SERIAL PRIMARY KEY,
       hash text NOT NULL,
       created_at bigint
     )`,
  );
}

describe("the migration plan against a real database", () => {
  const journal = realJournal();

  afterAll(async () => {
    // Left as it was found, so no later test file sees a table the harness does
    // not create for itself.
    await query(`drop schema if exists "drizzle" cascade`);
  });

  describe("before drizzle has ever run", () => {
    beforeAll(async () => {
      await query(`drop schema if exists "drizzle" cascade`);
    });

    it("reads a missing table as nothing applied, through the driver's real error", async () => {
      // THE CASE THE WHOLE SCRIPT HANGS ON: the first deploy, against a database
      // nothing has migrated. This is what failed before the fix, with the real
      // wrapped error that the unit tests could not reproduce from memory.
      await expect(readAppliedAt(query)).resolves.toEqual([]);
    });

    it("therefore plans every migration in the journal", async () => {
      const applied = await readAppliedAt(query);
      const pending = pendingMigrations(journal, applied);
      expect(pending.map((p) => p.tag)).toEqual(journal.entries.map((e) => e.tag));
    });
  });

  describe("once migrations have been recorded", () => {
    beforeAll(async () => {
      await createBookkeeping();
      await query(`delete from "drizzle"."__drizzle_migrations"`);
      for (const e of journal.entries) {
        await query(
          `insert into "drizzle"."__drizzle_migrations" ("hash", "created_at") values ('${e.tag}', ${e.when})`,
        );
      }
    });

    it("reads back one timestamp per recorded migration", async () => {
      const applied = await readAppliedAt(query);
      expect(applied.length).toBe(journal.entries.length);
    });

    it("reads them as numbers, though Postgres returns a bigint", async () => {
      // A bigint comes back as a string from this driver, and `Number.isFinite`
      // on a string is false - so a silent mis-read here would make every
      // migration look pending on every deploy, and train the owner to approve
      // five migrations every time they merge anything.
      const applied = await readAppliedAt(query);
      for (const value of applied) expect(typeof value).toBe("number");
      expect([...applied].sort((a, b) => a - b)).toEqual(
        journal.entries.map((e) => e.when).sort((a, b) => a - b),
      );
    });

    it("plans nothing, which is what an ordinary merge must look like", async () => {
      // No approval requested, so nobody is trained to click through one.
      const applied = await readAppliedAt(query);
      expect(pendingMigrations(journal, applied)).toEqual([]);
    });

    it("plans exactly the newest migration when that one row is missing", async () => {
      const newest = journal.entries.reduce((a, b) => (b.when > a.when ? b : a));
      await query(`delete from "drizzle"."__drizzle_migrations" where created_at = ${newest.when}`);

      const applied = await readAppliedAt(query);
      const pending = pendingMigrations(journal, applied);
      expect(pending.map((p) => p.tag)).toEqual([newest.tag]);

      // Put it back, so the order these tests run in cannot matter.
      await query(
        `insert into "drizzle"."__drizzle_migrations" ("hash", "created_at") values ('${newest.tag}', ${newest.when})`,
      );
    });

    it("still throws on a failure that is not a missing table", async () => {
      // The direction that costs something: "cannot read the database" must
      // never be reported as "nothing pending", because that hands the approver
      // an empty plan and then applies everything behind it. A syntax error is a
      // real Postgres failure that the missing-table matcher must not swallow.
      await expect(readAppliedAt(() => query("select created_at from"))).rejects.toThrow();
    });
  });
});
