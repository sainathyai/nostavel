// Run: npm run test:agents
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  JOURNAL_PATH,
  describePlan,
  pendingMigrations,
  readAppliedAt,
  repoRoot,
  unreadableEntries,
} from "./migrate-plan.mjs";

const journal = (...entries) => ({ entries });
const entry = (tag, when) => ({ idx: 0, version: "7", tag, when, breakpoints: true });

test("everything is pending against a database that has never been migrated", () => {
  // A brand-new environment, which is this repository's exact situation for the
  // first deploy - and the case where the approver most needs the whole list.
  const pending = pendingMigrations(journal(entry("0000_a", 100), entry("0001_b", 200)), []);
  assert.deepEqual(pending.map((p) => p.tag), ["0000_a", "0001_b"]);
});

test("nothing is pending when every migration has been applied", () => {
  const pending = pendingMigrations(journal(entry("0000_a", 100), entry("0001_b", 200)), [100, 200]);
  assert.deepEqual(pending, []);
});

test("only the migrations newer than the newest applied one are pending", () => {
  const j = journal(entry("0000_a", 100), entry("0001_b", 200), entry("0002_c", 300));
  assert.deepEqual(pendingMigrations(j, [100, 200]).map((p) => p.tag), ["0002_c"]);
});

// This mirrors what `drizzle-kit migrate` actually does, and the test is here to
// stop someone "improving" it into a membership check. An entry older than the
// newest applied migration will never be run, so reporting it as pending would
// send the owner looking for a change that is never going to happen.
test("an older entry that was never recorded is not reported as pending", () => {
  const j = journal(entry("0000_a", 100), entry("0001_b", 200));
  assert.deepEqual(pendingMigrations(j, [200]).map((p) => p.tag), []);
});

test("pending migrations come back oldest first, whatever order the journal is in", () => {
  const j = journal(entry("0002_c", 300), entry("0000_a", 100), entry("0001_b", 200));
  assert.deepEqual(pendingMigrations(j, []).map((p) => p.tag), ["0000_a", "0001_b", "0002_c"]);
});

test("an empty or absent journal means nothing is pending", () => {
  assert.deepEqual(pendingMigrations(journal(), []), []);
  assert.deepEqual(pendingMigrations({}, []), []);
  assert.deepEqual(pendingMigrations(null, []), []);
});

test("an entry with no usable tag or timestamp is counted as unreadable, not ignored", () => {
  // A journal this script cannot parse is a reason to stop and look, never a
  // reason to report "nothing to apply" and deploy.
  const j = journal(entry("0000_a", 100), { tag: "0001_b" }, { when: 300 }, entry(7, 400));
  assert.equal(unreadableEntries(j), 3);
  assert.deepEqual(pendingMigrations(j, []).map((p) => p.tag), ["0000_a"]);
});

test("a plan built from an unreadable journal fails rather than reporting a count", () => {
  const plan = describePlan([{ tag: "0000_a", when: 100 }], 2);
  assert.equal(plan.ok, false);
  assert.match(plan.summary, /cannot be read/);
});

test("a plan with nothing pending says so, so nobody is asked to approve nothing", () => {
  const plan = describePlan([], 0);
  assert.equal(plan.ok, true);
  assert.equal(plan.pending, 0);
  assert.match(plan.summary, /Nothing to approve/);
});

test("a plan names every migration the approver is being asked about", () => {
  const plan = describePlan([{ tag: "0004_magenta", when: 1791301485226 }], 0);
  assert.equal(plan.ok, true);
  assert.equal(plan.pending, 1);
  assert.deepEqual(plan.tags, ["0004_magenta"]);
  // The approver has to be able to see WHAT without opening a log.
  assert.match(plan.summary, /0004_magenta/);
  assert.match(plan.summary, /2026-/);
});

test("a missing migrations table reads as nothing applied, not as an error", () => {
  // What a database that has never been migrated looks like.
  const query = async () => {
    throw new Error('relation "drizzle.__drizzle_migrations" does not exist');
  };
  return readAppliedAt(query).then((applied) => assert.deepEqual(applied, []));
});

// THE DIRECTION THAT COSTS SOMETHING. "Cannot reach the database" must never be
// reported as "no migrations pending": that would hand the approver an empty
// plan and then apply five migrations behind it.
test("any other database failure is thrown, never reported as nothing applied", async () => {
  const query = async () => {
    throw new Error("getaddrinfo ENOTFOUND ep-cool-db.neon.tech");
  };
  await assert.rejects(() => readAppliedAt(query), /ENOTFOUND/);
});

test("applied timestamps are read as numbers, and unusable rows are dropped", async () => {
  const query = async () => [
    { created_at: "100" },
    { created_at: 200 },
    { created_at: null },
    { created_at: "not-a-number" },
  ];
  assert.deepEqual(await readAppliedAt(query), [100, 200]);
});

// Guards the scan itself, the way server-only-boundary.test.ts guards its own:
// if the journal moves or changes shape, this fails loudly here rather than the
// plan silently reporting nothing.
test("the real journal in this repository is readable and has entries", () => {
  const real = JSON.parse(readFileSync(join(repoRoot(), JOURNAL_PATH), "utf8"));
  assert.equal(unreadableEntries(real), 0);
  assert.ok(pendingMigrations(real, []).length >= 5, "expected at least the five migrations that exist");
  // Against a fully-migrated database, the real journal must plan nothing - which
  // is what every merge that touches no migration should look like.
  const allWhens = real.entries.map((e) => e.when);
  assert.deepEqual(pendingMigrations(real, allWhens), []);
});
