import { afterEach, describe, expect, it, vi } from "vitest";
import { is } from "drizzle-orm";
import { PgDatabase } from "drizzle-orm/pg-core";

// Each test re-imports the module so the lazily created client starts empty.
async function loadWithoutDatabaseUrl() {
  vi.resetModules();
  vi.stubEnv("DATABASE_URL", "");
  return import("./index");
}

describe("database client", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("can be imported without DATABASE_URL, so builds and CI need no database secret", async () => {
    await expect(loadWithoutDatabaseUrl()).resolves.toHaveProperty("db");
  });

  it("is still recognised as a Postgres database without connecting (the Auth.js adapter depends on it)", async () => {
    const { db } = await loadWithoutDatabaseUrl();
    expect(is(db, PgDatabase)).toBe(true);
  });

  it("fails with a clear message on first use when DATABASE_URL is missing", async () => {
    const { db } = await loadWithoutDatabaseUrl();
    expect(() => db.select()).toThrow(/DATABASE_URL is not set/);
  });
});
