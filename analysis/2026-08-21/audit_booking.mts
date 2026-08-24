// What did we ACTUALLY record for a booking, and does the checkout page's
// price story hold up against it? Reads the ledger row and re-derives every
// number the page renders, so a claim shown to a guest can be checked against
// the money that moved.
//
//     npx tsx analysis/2026-08-21/audit_booking.mts NSTVL-5VHTAZ
import { config } from "dotenv";
config({ path: ".env.local" });
import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import { desc, eq } from "drizzle-orm";
import { bookings } from "../../src/db/schema";

const db = drizzle(neon(process.env.DATABASE_URL!));
const ref = process.argv[2];

const rows = ref
  ? await db.select().from(bookings).where(eq(bookings.humanRef, ref.toUpperCase())).limit(1)
  : await db.select().from(bookings).orderBy(desc(bookings.createdAt)).limit(6);

for (const b of rows) {
  const room = (b.roomSnapshot ?? {}) as Record<string, any>;
  const total = b.amountTotalMinor;
  const net = b.amountSupplierMinor ?? 0;
  const fee = room.feeAtHotelMinor ?? 0;
  const them = room.themMinor ?? null;
  const m = (x: number) => "$" + (x / 100).toFixed(2);

  console.log("=".repeat(70));
  console.log(`${b.humanRef}  ${b.status}  ${b.checkinDate} -> ${b.checkoutDate}  userId=${b.userId ?? "GUEST"}`);
  console.log(`  charged (amountTotalMinor)      ${m(total)}`);
  console.log(`  supplier net                    ${m(net)}`);
  console.log(`  our commission                  ${m(total - net)}   = ${(((total - net) / total) * 100).toFixed(1)}% of charge`);
  console.log(`  fee due at property             ${m(fee)}`);
  console.log(`  themMinor (compare-at)          ${them == null ? "null" : m(them)}`);
  console.log();
  console.log("  WHAT THE PAGE CLAIMS:");
  if (them != null && them > total) {
    console.log(`    strikes ${m(them)} against ${m(total)}  -> implies saving ${m(them - total)}`);
    console.log(`    but also prints total cost of stay ${m(total + fee)}`);
    console.log(`    honest like-for-like: public total ${m(them + fee)} vs ours ${m(total + fee)}`);
    console.log(`      -> real saving ${m(them - total)} (${(((them - total) / (them + fee)) * 100).toFixed(1)}% of the public total)`);
  } else {
    console.log("    no compare-at shown");
  }
  const guestPct = Math.round((1 - net / total) * 100);
  console.log(`    "members save about ${guestPct}%"  <-- this is commission/charge, i.e. OUR MARGIN`);
}
