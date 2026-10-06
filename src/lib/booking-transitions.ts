// WHEN A HELD ROOM MAY BE LET GO, AND WHAT TO DO ABOUT A GUEST WHO MAY HAVE
// PAID. A pure rule: no database, no supplier, no clock of its own. The sweep
// route and the booking service supply `now` and act on the answer.
//
// THE THREE BUGS THIS EXISTS FOR
//
// NOS-46 - our clock disagreed with the supplier's twice over. The supplier
// releases a prebook hold 15 minutes after it is taken. Our sweeper used 30,
// and measured it from `updatedAt`, which `saveBookingGuest` rewrites - so
// filling in the guest form pushed our cutoff out to minute 44 while the
// supplier's hold had died at minute 15. The window actually enforced was "30
// minutes since the last write", which is not a hold at all. The cutoff is now
// measured from `prebookedAt`, the moment the hold was taken, which nothing
// else writes.
//
// NOS-5 - the sweeper could not tell a guest mid-payment from one who walked
// away, because nothing on the row recorded that a charge was in flight. The
// card is charged in the guest's browser, by the payment provider, with our
// server not involved; and there is no payment webhook (checked 2026-10-06
// against LiteAPI's event list: 22 events, all booking or flight lifecycle, none
// about payment). So the browser telling us is not one option among several, it
// is the only signal available - and `payment_pending`, a status this schema has
// always had and nothing ever set, is where it goes.
//
// WHY A ROW THAT MIGHT HAVE BEEN CHARGED IS NEVER SILENTLY EXPIRED. Measured
// 2026-10-06 (analysis/2026-10-06/probe-book-idempotency.mts): `book()` refuses
// an unpaid transaction with code 2014, "payment not completed". So attempting
// the booking IS the payment check, and a row we are unsure about can be
// resolved by trying it: it books if the guest paid, and says 2014 if they did
// not. That is only true while the hold is alive. Past it we cannot find out at
// all, and the answer is to alert a person - never to mark the row `expired`,
// because the guest's statement may show a pending charge that nothing in our
// system explains.

/** Minutes the supplier holds a prebooked room. LiteAPI documentation. */
export const PREBOOK_HOLD_MINUTES = 15;

/**
 * How long after the guest's browser says "charging now" we stop waiting for it
 * to come back and find out for ourselves.
 *
 * Two minutes. A card step including a bank 3-D Secure interstitial is seconds
 * to tens of seconds; at two minutes the browser has almost certainly not
 * survived, and we still have most of the hold window left to act in. Shorter
 * would race a slow interstitial - harmlessly, since an unpaid attempt comes
 * back 2014 and changes nothing, but it would spend a supplier call to learn
 * that.
 */
export const RECOVER_AFTER_MINUTES = 2;

/**
 * How long a claimed-but-unfinished confirmation is believed to be in flight.
 *
 * One caller claims a booking before calling the supplier (NOS-6). If that
 * process dies mid-call, the claim outlives it, and nothing else may finalize
 * the booking while it stands. Three minutes is comfortably longer than a
 * supplier call and short enough that a guest who paid is not left waiting.
 */
export const CLAIM_STALE_AFTER_MINUTES = 3;

export type TransitionStatus =
  | "draft"
  | "prebooked"
  | "payment_pending"
  | "confirming"
  | "confirmed"
  | "failed"
  | "cancelled"
  | "expired";

/** Only what the decision needs. Deliberately not the whole row. */
export type SweepCandidate = {
  status: TransitionStatus;
  /** When the supplier hold was taken. Null for rows created before NOS-46. */
  prebookedAt: Date | null;
  /** Last write. Used for "how long in this state", never for the hold. */
  updatedAt: Date;
};

export type SweepAction =
  /** Nothing to do yet. */
  | { action: "leave"; reason: string }
  /** The hold has lapsed and nobody ever told us a payment started. */
  | { action: "expire"; reason: string }
  /** Ask the supplier to book it: that answers whether the guest paid. */
  | { action: "recover"; reason: string }
  /** Release the claim so it can be recovered on this or a later pass. */
  | { action: "reclaim"; reason: string }
  /** A person has to look. Never paired with expiring the row. */
  | { action: "alert"; reason: string };

const MINUTE = 60_000;

function minutesSince(then: Date, now: Date): number {
  return (now.getTime() - then.getTime()) / MINUTE;
}

/** Has the supplier's hold on this room lapsed? */
export function holdLapsed(prebookedAt: Date | null, now: Date): boolean {
  // A row with no recorded prebook moment predates NOS-46. Treating it as
  // lapsed would expire it on the first sweep after deploy; treating it as
  // alive leaves it to be caught by its own state instead. The migration
  // backfills this column, so the case is a safety net, not a path.
  if (!prebookedAt) return false;
  return minutesSince(prebookedAt, now) >= PREBOOK_HOLD_MINUTES;
}

/**
 * What the sweeper should do with one row.
 *
 * Every branch is explicit and the fall-through is `leave`: a status this rule
 * has not been taught about keeps its row rather than losing it.
 */
export function sweepDecision(row: SweepCandidate, now: Date): SweepAction {
  const lapsed = holdLapsed(row.prebookedAt, now);
  const inStateFor = minutesSince(row.updatedAt, now);

  switch (row.status) {
    case "prebooked":
      // Nobody told us a payment started. If the hold is gone, so is the room -
      // keeping the row `prebooked` only means the checkout page keeps offering
      // a rate the supplier has already let go (NOS-46).
      if (!lapsed) return { action: "leave", reason: "hold is still alive" };
      return { action: "expire", reason: "hold lapsed with no payment started" };

    case "payment_pending":
      // The guest's browser said it was about to charge the card. This row is
      // never expired on a timer (NOS-5): we find out instead.
      if (inStateFor < RECOVER_AFTER_MINUTES) {
        return { action: "leave", reason: "payment may still be in progress" };
      }
      if (!lapsed) {
        return { action: "recover", reason: "payment started but never finished" };
      }
      return {
        action: "alert",
        reason: "hold lapsed while a payment was in flight; the guest may be charged",
      };

    case "confirming":
      // Claimed by a caller that then went quiet.
      if (inStateFor < CLAIM_STALE_AFTER_MINUTES) {
        return { action: "leave", reason: "a confirmation is in flight" };
      }
      if (!lapsed) return { action: "reclaim", reason: "claim is stale" };
      return {
        action: "alert",
        reason: "hold lapsed mid-confirmation; the guest may be charged",
      };

    // Terminal or not ours. `draft` rows have never reached the supplier, so
    // there is no hold to release and nothing to recover.
    default:
      return { action: "leave", reason: `nothing to do for ${row.status}` };
  }
}

/**
 * The supplier's answer to "was this paid?", read from a failed recovery.
 *
 * Code 2014 is the documented refusal for an unpaid transaction, and it is the
 * whole reason recovery works. Anything else means we did not get an answer,
 * which is not the same as "no".
 */
export function isUnpaidRefusal(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error ?? "");
  return /\b2014\b/.test(text) || /payment not completed/i.test(text);
}

export type RecoveryOutcome =
  /** The guest had paid; the booking now exists. */
  | { outcome: "confirmed" }
  /** Provably unpaid. Safe to release the room once the hold is gone. */
  | { outcome: "expire"; reason: string }
  /** Provably unpaid, but the hold is still alive - they may yet pay. */
  | { outcome: "leave"; reason: string }
  /** We did not get an answer. A person looks; the row is left alone. */
  | { outcome: "alert"; reason: string };

/**
 * What a recovery attempt's result means.
 *
 * Kept pure and separate from the attempt itself so every branch is testable
 * without a supplier: this is the function that decides whether a guest's room
 * is released, and it must never conclude "unpaid" from silence.
 */
export function recoveryOutcome(
  result: { ok: true } | { ok: false; error: unknown },
  holdHasLapsed: boolean,
): RecoveryOutcome {
  if (result.ok) return { outcome: "confirmed" };

  if (isUnpaidRefusal(result.error)) {
    return holdHasLapsed
      ? { outcome: "expire", reason: "supplier confirms the transaction was never paid" }
      : { outcome: "leave", reason: "not paid yet, and the hold is still alive" };
  }

  return {
    outcome: "alert",
    reason: "the supplier did not say whether the guest paid",
  };
}
