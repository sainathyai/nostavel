// Nightly reconciliation. docs/production-readiness.md §2.4: even with the
// webhook receiver, state can drift (a missed delivery, a rotated secret, an
// endpoint that was briefly down). This walks our ledger, compares each
// booking's status against LiteAPI's own, and WRITES A MISMATCH EVENT — it
// never silently corrects the ledger. That rule is explicit in the doc and
// matches conventions.md §8 (the ledger is append-only, evidence, not
// something this job may rewrite).
//
// EXCLUDING LEGACY ROWS: corrected in NOS-64, and the correction is the point of
// this ticket.
//
// This job used to borrow the reporting store's predicate from §1.2 verbatim:
// `amount_supplier_minor is not null and human_ref not like 'FIX%'`. That
// predicate is right for a revenue report, where an unknown supplier net would
// book profit that never existed. It is wrong here, for two reasons.
//
//  1. **It asks the wrong question.** A null supplier cost is a *proxy* for "this
//     row predates the ledger". The thing that actually makes those rows legacy is
//     that they are the `LNTRN-*` era, 2026-08-03 to 08-05 (§1.2 measured all 16).
//     Filtering on the proxy also catches every row written since, which brings us
//     to:
//  2. **It hid exactly the rows most worth reconciling.** A *current-era* confirmed
//     booking with no recorded supplier cost means we told a guest they have a room
//     and have no record of what the supplier charged us for it. `isNotNull`
//     excluded it permanently, so the reconciler could never see it and its silence
//     meant "nothing to compare", not "nothing is wrong". Measured against the test
//     environment during NOS-61: 2 of 3 candidate rows were excluded this way.
//
// So the exclusions now name what they mean: the `LNTRN-*` legacy era and the
// `FIX*` prebook fixtures. §1.2's decision is unchanged - those rows stay excluded
// and the ledger is not rewritten - but a row from the real era is no longer
// invisible because one column is null.
//
// Note also that §1.2 said its rule "belongs in ONE place, the reporting store,
// never copied into each view". It had been copied here. That is how a predicate
// written for revenue reporting ended up deciding what a money-safety job can see.
import { and, eq, inArray, notLike } from "drizzle-orm";
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
        // The legacy era and the prebook fixtures, named for what they are
        // rather than inferred from a null column. See the note at the top.
        notLike(bookings.humanRef, "LNTRN-%"),
        notLike(bookings.humanRef, "FIX%"),
      ),
    );

  let checked = 0;
  let mismatches = 0;
  let missingSupplierCost = 0;
  const errors: { bookingId: string; error: string }[] = [];

  for (const row of rows) {
    // A current-era row with no recorded supplier cost is itself the finding, and
    // it is reported whether or not the supplier can be reached below: the ledger
    // is incomplete regardless of what the supplier says about the status. Written
    // once per booking, because this job runs nightly and a permanent condition
    // would otherwise collect one identical event per night forever.
    if (row.amountSupplierMinor === null) {
      missingSupplierCost++;
      await appendOnce(row.id, "reconcile.missing_supplier_cost", {
        status: row.status,
        humanRef: row.humanRef,
      });
    }

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

  return Response.json({ ok: true, checked, mismatches, missingSupplierCost, errors });
}

/**
 * Append an event unless this booking already has one of that type.
 *
 * THIS IS THE THIRD COPY of this helper: the sweeper has one
 * (`src/app/api/cron/sweep/route.ts`) and `booking-service.ts` has the same shape
 * inside `recordUnresolvedPayment`. It is duplicated here deliberately rather
 * than consolidated, to keep this change to the one ticket it is about. The
 * consolidation belongs with the sweeper work that is next in the same phase and
 * already edits one of the copies.
 *
 * `booking_events` is append-only (docs/conventions.md §8), so this skips rather
 * than updating.
 */
async function appendOnce(
  bookingId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const existing = await db
    .select({ id: bookingEvents.id })
    .from(bookingEvents)
    .where(and(eq(bookingEvents.bookingId, bookingId), eq(bookingEvents.type, type)))
    .limit(1);
  if (existing.length) return;
  await db.insert(bookingEvents).values({ bookingId, type, actor: "reconciler", payload });
}
