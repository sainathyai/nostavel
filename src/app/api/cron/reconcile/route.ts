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
//
// **DO NOT COPY THIS PREDICATE INTO A MONEY REPORT.** It is the opposite of the
// one §1.2 settled, and for a good reason: this job wants to SEE a row with an
// unknown supplier cost, and a revenue report must NOT, because `total - (net ??
// 0)` on those rows books $972.29 of profit that never existed. The two
// predicates look interchangeable and are not. The security review of NOS-64
// asked for this sentence, on the grounds that this file's own history is a
// persuasive comment getting copied to a place where it was wrong.
//
// CASE AND ERA (NOS-64 security review, F7). The exclusions are
// case-insensitive, because `human_ref` is free text and Postgres `LIKE` is not,
// so `lntrn-795bnm` would otherwise walk straight through a filter written for
// `LNTRN-%`. And because the comment above defines the legacy population as a
// DATE ERA while a prefix is only a proxy for it, the era itself is excluded too:
// a row created before the real ledger began is legacy whatever it is called.
// Belt and braces, deliberately, because this predicate is now the only thing
// standing between a false nightly mismatch and a human learning to ignore them.
import { and, eq, gte, inArray, notIlike } from "drizzle-orm";
import { db } from "@/db";
import { bookings, bookingEvents } from "@/db/schema";
import { getSupplierBooking } from "@/lib/liteapi";
import { authorizeCronRequest } from "@/lib/cron-auth";
import { logInfo, logWarning } from "@/lib/log";
import { statusesAgree, summarise } from "@/lib/cron-format";

/**
 * When the ledger started meaning what it means today: the first `NSTVL-*` row,
 * 2026-08-12 (docs/production-readiness.md §1.2, measured 2026-08-23). Anything
 * older is the `LNTRN-*` era, which recorded no supplier net at all and would
 * mismatch forever if compared.
 *
 * A date rather than a row count because the eras are defined by date in §1.2,
 * and midnight UTC on the 12th because the first real row is from that day and
 * the three eras do not overlap.
 */
const LEDGER_ERA_BEGAN = new Date("2026-08-12T00:00:00.000Z");

export async function POST(request: Request) {
  const now = new Date();

  // Either a Cloud Scheduler OIDC token or the legacy shared secret (NOS-65).
  const auth = await authorizeCronRequest(request, "reconcile", now);
  if (!auth.ok) {
    logWarning("cron.reconcile.unauthorized", `A reconcile call was refused: ${auth.reason}`, {
      reason: auth.reason,
    });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  // WHICH credential ran this, logged on success (security review of NOS-65, H1).
  // Without it `via` was computed and thrown away, and two things became
  // unanswerable: whether a partial Terraform apply had silently reverted this
  // job to the repository-scoped shared secret, and NOS-65's own precondition
  // for deleting that secret path, which is 72 hours of Scheduler delivery
  // "counted from booking_events and Cloud Run logs". No ledger row can tell a
  // Scheduler run from a workflow_dispatch run from someone's curl. This line can.
  logInfo("cron.reconcile.authorized", `A reconcile pass was authorised by ${auth.via}.`, {
    via: auth.via,
  });

  const rows = await db
    .select()
    .from(bookings)
    .where(
      and(
        inArray(bookings.status, ["confirmed", "cancelled"]),
        // The legacy era and the prebook fixtures, named for what they are
        // rather than inferred from a null column. See the note at the top.
        notIlike(bookings.humanRef, "LNTRN-%"),
        notIlike(bookings.humanRef, "FIX%"),
        // The era itself, so the code states what the comment claims rather than
        // trusting a reference prefix nobody enforces. `created_at` is NOT NULL
        // with a default, so this needs no null branch.
        gte(bookings.createdAt, LEDGER_ERA_BEGAN),
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

  // A COMPLETED pass, which is what the absence alert watches (NOS-65 part 3
  // review, M2). The `authorized` line above is emitted before a single row is
  // read, so a job that authenticates and then throws on its first query would
  // have fed the metric every 5 minutes while rescuing nobody. `via` is carried
  // so the metric can require `oidc` and not be kept alive by a GitHub
  // workflow_dispatch run, which is also what makes this ticket's "72 hours of
  // Scheduler delivery" precondition answerable.
  // `event` and `via` are TOP-LEVEL FIELDS because `infra/envs/uat/scheduler.tf`
  // filters on exactly those two paths; `log-contract.test.ts` holds that link.
  logInfo(
    "cron.reconcile.completed",
    `A reconcile pass completed via ${auth.via}: ${summarise({ checked, mismatches, missingSupplierCost, errors: errors.length })}`,
    { via: auth.via, checked, mismatches, missingSupplierCost, errors: errors.length },
  );
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
