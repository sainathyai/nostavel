import { config } from "dotenv";
config({ path: ".env.local" });
import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import { bookings } from "../../src/db/schema";
import { randomUUID } from "node:crypto";
const db = drizzle(neon(process.env.DATABASE_URL!));
const id = randomUUID();
const oldTime = new Date(Date.now() - 60 * 60_000);
await db.insert(bookings).values({
  id,
  idempotencyKey: "sweep-test-" + id,
  humanRef: "FIX" + String(Date.now()).slice(-5),
  status: "prebooked",
  userId: null,
  hotelId: "lp85c07",
  hotelSnapshot: { name: "Sweep Test" },
  checkinDate: "2026-10-01",
  checkoutDate: "2026-10-03",
  nights: 2,
  amountTotalMinor: 10000,
  paymentSecret: "pi_test_secret_should_be_cleared",
  updatedAt: oldTime,
  createdAt: oldTime,
});
console.log("inserted stale prebooked row:", id);
