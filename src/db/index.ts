// Server-only database client.
//
// Uses Neon's HTTP driver: each query is a stateless HTTPS round-trip, which is
// ideal for Cloud Run's scale-to-zero / ephemeral instances (no long-lived
// connection pool to exhaust). For atomic multi-table writes, use `db.batch([...])`
// — the neon-http driver runs a batch inside a single transaction.
import "server-only";
import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set. Add it to .env.local (Neon connection string).");
}

const sql = neon(connectionString);
export const db = drizzle(sql, { schema });
export { schema };
