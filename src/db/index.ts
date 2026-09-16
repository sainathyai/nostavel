// Server-only database client.
//
// Uses Neon's HTTP driver: each query is a stateless HTTPS round-trip, which is
// ideal for Cloud Run's scale-to-zero / ephemeral instances (no long-lived
// connection pool to exhaust). For atomic multi-table writes, use `db.batch([...])`
// — the neon-http driver runs a batch inside a single transaction.
//
// CONNECTS ON FIRST USE, NOT ON IMPORT. This module used to throw at import
// when DATABASE_URL was unset, so `next build` (which imports every route) and
// CI needed a real database credential even though no query runs at build time.
// On a public repository, pull requests from forks never receive secrets, so
// the check has to move to the first query.
//
// The Proxy's target is created from NeonHttpDatabase.prototype on purpose.
// Auth.js's Drizzle adapter identifies the database with drizzle's
// `is(db, PgDatabase)` when src/auth.ts loads, which walks the prototype chain.
// A plain object target fails that check ("Unsupported database type"), and
// anything that read a property to answer it would connect at import again.
// src/db/index.test.ts pins both behaviours.
import "server-only";
import { drizzle, NeonHttpDatabase } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import * as schema from "./schema";

type Db = NeonHttpDatabase<typeof schema>;

let instance: Db | null = null;

function connect(): Db {
  if (instance) return instance;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Add it to .env.local (Neon connection string).");
  }
  instance = drizzle(neon(connectionString), { schema });
  return instance;
}

export const db: Db = new Proxy(Object.create(NeonHttpDatabase.prototype) as Db, {
  get(_target, prop) {
    const real = connect();
    const value = Reflect.get(real, prop, real);
    // Drizzle's query builders are methods that rely on `this`.
    return typeof value === "function" ? value.bind(real) : value;
  },
});

export { schema };
