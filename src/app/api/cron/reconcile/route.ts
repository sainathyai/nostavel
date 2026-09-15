// Nightly reconciliation. docs/production-readiness.md §2.4: even with the
// webhook receiver, state can drift (a missed delivery, a rotated secret, an
// endpoint that was briefly down). This walks our ledger, compares each
// booking's status against LiteAPI's own, and WRITES A MISMATCH EVENT — it
// never silently corrects the ledger. That rule is explicit in the doc and
// matches conventions.md §8 (the ledger is append-only, evidence, not
// something this job may rewrite).
//
// Excludes legacy/fixture rows using the SAME predicate the doc settled on
// for the future money-view reporting store (§1.2): rows with no recorded
// supplier cost, or a `FIX*` human_ref, were written before this ledger meant
// what it means today and would produce false "mismatches" forever if
// compared.
import { and, inArray, isNotNull, notLike } from "drizzle-orm";
import { db } from "@/db";
import { bookings, bookingEvents } from "@/db/schema";
import { getSupplierBooking } from "@/lib/liteapi";
import { verifySharedSecret } from "@/lib/webhook-auth";
import { statusesAgree } from "@/lib/cron-format";

export async function POST(request: Request) {
  const auth = request.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : auth;
  if (!verifySharedSecret(bearer, process.env.CRON_SECRET)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const rows = await db
    .select()
    .from(bookings)
    .where(
      and(
        inArray(bookings.status, ["confirmed", "cancelled"]),
        isNotNull(bookings.amountSupplierMinor),
        notLike(bookings.humanRef, "FIX%"),
      ),
    );

  let checked = 0;
  let mismatches = 0;
  const errors: { bookingId: string; error: string }[] = [];

  for (const row of rows) {
    if (!row.liteapiBookingId) continue;
    checked++;
    let supplier: unknown;
    try {
      supplier = await getSupplierBooking(row.liteapiBookingId);
    } catch (e) {
      errors.push({ bookingId: row.id, error: (e as Error).message });
      continue;
    }
    const supplierStatus =
      typeof (supplier as Record<string, unknown>)?.status === "string"
        ? ((supplier as Record<string, unknown>).status as string)
        : null;

    // Safe: the query above filters to exactly these two statuses.
    if (!statusesAgree(row.status as "confirmed" | "cancelled", supplierStatus)) {
      mismatches++;
      await db.insert(bookingEvents).values({
        bookingId: row.id,
        type: "reconcile.mismatch",
        actor: "reconciler",
        payload: { ourStatus: row.status, supplierStatus, supplier },
      });
    }
  }

  return Response.json({ ok: true, checked, mismatches, errors });
}
