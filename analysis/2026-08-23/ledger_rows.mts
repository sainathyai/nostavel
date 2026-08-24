/**
 * Question this answers: exactly which ledger rows would corrupt a revenue
 * report, and by how much? Section 1.2 / decision 4 of docs/production-readiness.md
 * says "two rows with supplier net 0.00" but never showed the rows.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

const { neon } = await import("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL!);

const rows = await sql`
  select human_ref as reference, status, created_at, currency,
         amount_total_minor, amount_supplier_minor, transaction_id, liteapi_booking_id as external_id
  from bookings
  order by created_at asc
`;

console.log("total rows:", rows.length);
for (const r of rows as Record<string, unknown>[]) {
  const total = Number(r.amount_total_minor) / 100;
  const net = r.amount_supplier_minor == null ? null : Number(r.amount_supplier_minor) / 100;
  const commission = net == null ? null : total - net;
  const pct = net ? ((commission! / total) * 100).toFixed(1) + "%" : "n/a";
  console.log(
    [
      String(r.reference).padEnd(14),
      String(r.status).padEnd(15),
      new Date(r.created_at as string).toISOString().slice(0, 10),
      `total ${total.toFixed(2)}`.padEnd(14),
      `net ${net == null ? "NULL" : net.toFixed(2)}`.padEnd(13),
      `commission ${commission == null ? "?" : commission.toFixed(2)} (${pct})`.padEnd(30),
      r.transaction_id ? "txn ok" : "txn NULL",
      r.external_id ? "ext ok" : "ext NULL",
    ].join("  "),
  );
}
