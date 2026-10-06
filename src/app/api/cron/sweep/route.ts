// Abandoned-hold sweeper, and the only thing that resolves a booking whose
// guest may have been charged.
//
// WHAT IT USED TO DO, AND WHY THAT LOST MONEY. It expired any `prebooked` or
// `payment_pending` row whose `updatedAt` was older than 30 minutes. Three
// things were wrong with that at once:
//
//   - It could not tell a guest mid-payment from one who closed the tab,
//     because nothing on the row said a charge was in flight. So it released
//     rooms out from under paying guests, who were charged and got nothing
//     (NOS-5).
//   - 30 minutes, against a supplier hold of 15 (NOS-46).
//   - Measured from `updatedAt`, which `saveBookingGuest` rewrites — so filling
//     in the guest form pushed the cutoff out to minute 44 while the hold had
//     already died at 15. The window enforced was "30 minutes since the last
//     write", which is not a hold at all.
//
// WHAT IT DOES NOW. The decision is a pure rule
// (src/lib/booking-transitions.ts); this file supplies the clock, performs the
// writes, and interprets what the supplier says. The rule's shape:
//
//   prebooked, hold lapsed, nobody said they were paying  -> release the room
//   payment_pending, browser went quiet                   -> ASK THE SUPPLIER
//   confirming, claim went stale                          -> release the claim
//   either, past the hold                                 -> alert a person
//
// "Ask the supplier" is possible because `book()` refuses an unpaid transaction
// with code 2014, "payment not completed" (measured 2026-10-06,
// analysis/2026-10-06/probe-book-idempotency.mts). Attempting the booking IS
// the payment check. So a row we are unsure about gets resolved rather than
// guessed at: it books if the guest paid, and says 2014 if they did not.
//
// A ROW THAT MIGHT HAVE BEEN CHARGED IS NEVER MARKED `expired`. Only an
// explicit 2014 releases a room. Silence — a timeout, a rate limit, a 500 — is
// not evidence of non-payment, and treating it as such is how a guest ends up
// with a charge on their statement that nothing in our system explains.
//
// SAFE UNDER CONCURRENT RUNS WITHOUT A LOCK: every transition is a single
// `UPDATE ... WHERE status = '<from>' ... RETURNING`, and Postgres's own
// row-level atomicity is the mutex — a second overlapping run's WHERE clause
// simply matches nothing once the first has flipped the row, the same
// compare-and-swap idea `idempotencyKey` already relies on elsewhere. No
// advisory lock is available anyway: the neon-http driver is stateless per
// query, so a lock spanning two queries couldn't be held reliably.
//
// Triggered by a scheduled GitHub Actions workflow
// (.github/workflows/cron-sweep.yml) rather than a platform-specific cron —
// no deploy target is chosen yet, and this works under any future host.
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { bookings, bookingEvents } from "@/db/schema";
import { confirmBooking } from "@/lib/booking-service";
import {
  holdLapsed,
  recoveryOutcome,
  sweepDecision,
  type SweepCandidate,
} from "@/lib/booking-transitions";
import { verifySharedSecret } from "@/lib/webhook-auth";

export const runtime = "nodejs";

// How many rows one pass will call the supplier for. A backlog is worked
// through over successive passes rather than in one burst that could trip the
// supplier's rate limit — which returns 429, which is silence, which this
// sweeper is careful never to read as "unpaid".
const RECOVERY_BUDGET = 10;

type Counts = {
  holdsExpired: number;
  recovered: number;
  releasedAfterUnpaid: number;
  claimsReleased: number;
  alerts: number;
  leftAlone: number;
};

export async function POST(request: Request) {
  const auth = request.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : auth;
  if (!verifySharedSecret(bearer, process.env.CRON_SECRET)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const counts: Counts = {
    holdsExpired: 0,
    recovered: 0,
    releasedAfterUnpaid: 0,
    claimsReleased: 0,
    alerts: 0,
    leftAlone: 0,
  };

  // Only the three live states. Everything else is terminal, and the rule
  // leaves them alone anyway — not fetching them keeps the scan small as the
  // ledger grows.
  const candidates = await db
    .select()
    .from(bookings)
    .where(inArray(bookings.status, ["prebooked", "payment_pending", "confirming"]));

  let recoveryBudget = RECOVERY_BUDGET;

  for (const row of candidates) {
    const candidate: SweepCandidate = {
      status: row.status,
      prebookedAt: row.prebookedAt,
      updatedAt: row.updatedAt,
    };
    const decision = sweepDecision(candidate, now);

    switch (decision.action) {
      case "leave":
        counts.leftAlone++;
        break;

      case "expire": {
        // Compare-and-swap on the status we decided from: if anything moved the
        // row since the read — a guest returning to pay, most importantly —
        // this matches nothing and the row is left alone.
        const done = await db
          .update(bookings)
          .set({ status: "expired", paymentSecret: null, updatedAt: new Date() })
          .where(and(eq(bookings.id, row.id), eq(bookings.status, "prebooked")))
          .returning({ id: bookings.id });
        if (done.length) {
          counts.holdsExpired++;
          await db.insert(bookingEvents).values({
            bookingId: row.id,
            type: "hold.expired",
            actor: "system",
            payload: { reason: decision.reason },
          });
        }
        break;
      }

      case "reclaim": {
        // A caller claimed this and went quiet. Put it back so it can be
        // recovered — on this pass if the budget allows, otherwise the next.
        const done = await db
          .update(bookings)
          .set({ status: "payment_pending", updatedAt: new Date() })
          .where(and(eq(bookings.id, row.id), eq(bookings.status, "confirming")))
          .returning({ id: bookings.id });
        if (done.length) {
          counts.claimsReleased++;
          await db.insert(bookingEvents).values({
            bookingId: row.id,
            type: "confirm.claim_released",
            actor: "system",
            payload: { reason: decision.reason },
          });
        }
        break;
      }

      case "alert": {
        // The hold is gone and we cannot find out whether the guest paid. The
        // row keeps its status on purpose: marking it `expired` would close the
        // only record saying a human still has to look.
        //
        // The supplier releases an unfinalized charge itself within 1–2
        // business days (NOS-45), so the money is not lost — but the guest's
        // statement may show a pending charge, and this event is the only thing
        // that explains it.
        counts.alerts++;
        await appendOnce(row.id, "payment.unresolved", { reason: decision.reason });
        break;
      }

      case "recover": {
        if (recoveryBudget <= 0) {
          counts.leftAlone++;
          break;
        }
        recoveryBudget--;
        await recover(row.id, holdLapsed(row.prebookedAt, now), counts, decision.reason);
        break;
      }
    }
  }

  return Response.json({ ok: true, ...counts });
}

/**
 * Finish a booking whose guest may already have paid, by asking the supplier.
 *
 * `confirmBooking` is reused rather than reimplemented: it already claims the
 * row, calls the supplier, writes the ledger and sends the confirmation email,
 * and a second copy of that sequence here would be a second place for it to
 * drift. Its claim also means this cannot collide with the guest's own browser
 * arriving at the same moment — one wins, the other is told it is being
 * finalized.
 */
async function recover(
  bookingId: string,
  holdHasLapsed: boolean,
  counts: Counts,
  reason: string,
): Promise<void> {
  let result: { ok: true } | { ok: false; error: unknown };
  try {
    const confirmed = await confirmBooking({ bookingId });
    // "finalizing" means a guest's own request claimed it first — the best
    // possible outcome, and nothing for this pass to do.
    if (confirmed.status === "finalizing") {
      counts.leftAlone++;
      return;
    }
    result = { ok: true };
  } catch (e) {
    result = { ok: false, error: e };
  }

  const outcome = recoveryOutcome(result, holdHasLapsed);

  switch (outcome.outcome) {
    case "confirmed":
      counts.recovered++;
      await appendOnce(bookingId, "payment.recovered", { reason });
      return;

    case "expire": {
      // The only route to releasing a room a payment was started for: the
      // supplier itself said the transaction was never paid.
      const done = await db
        .update(bookings)
        .set({ status: "expired", paymentSecret: null, updatedAt: new Date() })
        .where(and(eq(bookings.id, bookingId), eq(bookings.status, "payment_pending")))
        .returning({ id: bookings.id });
      if (done.length) {
        counts.releasedAfterUnpaid++;
        await appendOnce(bookingId, "hold.expired", { reason: outcome.reason });
      }
      return;
    }

    case "leave":
      counts.leftAlone++;
      return;

    case "alert":
      counts.alerts++;
      await appendOnce(bookingId, "payment.unresolved", { reason: outcome.reason });
      return;
  }
}

/**
 * Append a ledger event, at most once per booking per type.
 *
 * The sweeper runs on a schedule, so an unresolved row would otherwise collect
 * one identical alert per pass forever — and an alert nobody can read is an
 * alert nobody reads. `booking_events` is append-only (docs/conventions.md §8),
 * so this skips rather than updates.
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
  await db.insert(bookingEvents).values({ bookingId, type, actor: "system", payload });
}
