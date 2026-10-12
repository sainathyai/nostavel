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
 * Code 2014 is the refusal for an unpaid transaction, and it is the whole reason
 * recovery works at all. Anything else means we did not get an answer, which is
 * not the same as "no".
 *
 * THE CODE, NOT THE PROSE. The first version of this matched the thrown message
 * text, and could not match the one response it existed for. The supplier sends
 * `code: 2014`, `description: "payment not completed"`, `message: "booking
 * incomplete"` - and the client's thrown text carried only the `message`. So
 * "booking incomplete" was all this function ever saw, it returned false, and
 * the whole release path downstream was dead code, while a guest finishing a slow
 * card step was marked `failed` and never looked at again. Found by the NOS-5
 * security review, after the evidence had been sitting in this repository's own
 * probe output (analysis/2026-10-06/raw) the entire time.
 *
 * Read structurally rather than by importing the error class, so this stays a
 * pure rule with no dependency on the supplier client.
 */
export function isUnpaidRefusal(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "number") return code === 2014;

  // Secondary only, for an error that reached us as text: a stringified log
  // line, or a rethrow that lost its type. Never the primary signal.
  const description = (error as { description?: unknown } | null)?.description;
  const text = [
    error instanceof Error ? error.message : String(error ?? ""),
    typeof description === "string" ? description : "",
  ].join(" ");
  return /\b2014\b/.test(text) || /payment not completed/i.test(text);
}

/**
 * What the confirmation page should do with a booking in this state.
 *
 * EXTRACTED BECAUSE IT WAS WRONG AS A CHAIN OF INLINE `if`s. That page is the
 * payment provider's return URL and the only thing that finalizes a booking on
 * the happy path. It finalized only from `prebooked` - so once the browser
 * started marking `payment_pending` before charging, every successful payment
 * fell through to the failure branch: no booking, no email, and a red page
 * telling a guest who had just paid that their charge would be reversed. Both
 * review gates found it independently, in a file this change had not touched.
 *
 * There is no component test tier in this repository, so a branch living in the
 * page is a branch nothing in CI can check. Here it is a pure function with
 * cases, and the page becomes a switch over the answer. That is the difference
 * between fixing this bug and fixing the next one like it.
 */
export type FinalizeIntent =
  /** Call the supplier. The guest is mid-checkout and may already have paid. */
  | "finalize"
  /** Someone else is finalizing it. Say so; do not call the supplier. */
  | "wait"
  /** Done. Render the confirmation. */
  | "done"
  /**
   * The room is still held, but nothing says a payment was ever started. Send
   * the guest back to the card step. Spend nothing (NOS-51).
   */
  | "resume"
  /** This booking cannot be completed, and no payment was ever started for it. */
  | "dead";

/**
 * What the confirmation page knows about how this request arrived.
 *
 * `providerReturn` is the answer to "did the payment provider send this browser
 * here after a charge attempt", and it is the reason this is an object rather
 * than a bare status - see the NOS-51 note on the function below.
 */
export type ConfirmationArrival = {
  status: TransitionStatus;
  providerReturn: boolean;
};

/**
 * NOS-51: A GET MUST NOT SPEND MONEY UNLESS A CHARGE WAS ACTUALLY STARTED.
 *
 * This page is the payment provider's return URL, and it used to finalize from
 * `prebooked` as well as `payment_pending` - which means a prefetch, a restored
 * tab, or a link opened from history could call the supplier's `book()` without
 * the guest deciding anything. That is the whole ticket (D-7.1 A).
 *
 * So the question becomes: what counts as evidence that a charge was started?
 *
 * `payment_pending` is our own breadcrumb, written by the browser just before it
 * charges the card. It is the normal arrival state and the strongest signal we
 * own - but it is written on a best-effort basis and `CheckoutClient` swallows
 * its failure on purpose, because the charge matters more than the breadcrumb.
 * So `prebooked` does NOT mean "never charged". The test for the old behaviour
 * said so in as many words: "still accepted: a browser that failed to send the
 * heads-up charged anyway."
 *
 * Dropping `prebooked` on its own would therefore have told a guest who had just
 * paid to go and pay again. The fix is not to keep guessing from the status, it
 * is to ask the only party that knows: `providerReturn` is true when the payment
 * provider redirected this browser here, which it does only after a charge
 * attempt. That is better evidence than our own breadcrumb, not worse.
 *
 * The two together give four cases that matter:
 *
 *   payment_pending, however it arrived  -> finalize. We said a charge started.
 *   prebooked + provider redirect        -> finalize. The provider says one did.
 *   prebooked, no redirect               -> RESUME. Nobody says a charge started,
 *                                          so spend nothing and offer the card
 *                                          step again.
 *   anything else                        -> as before.
 *
 * `providerReturn` comes from a URL the browser controls, so it is forgeable.
 * That is acceptable and worth being explicit about: the holder of a booking id
 * who passes the ownership check could already finalize it before this change.
 * The worst a forged parameter buys is one supplier call, which comes back 2014
 * "payment not completed" for an unpaid transaction and leaves the row exactly
 * where it was (see statusAfterFailedBook). It can cost a call; it cannot
 * confirm an unpaid booking.
 */
export function confirmationPageIntent(arrival: ConfirmationArrival): FinalizeIntent {
  switch (arrival.status) {
    case "confirmed":
      return "done";

    // Our own breadcrumb: the browser told us it was about to charge. This is
    // the NORMAL arrival state on the happy path.
    case "payment_pending":
      return "finalize";

    // The room is held and we have no breadcrumb. Only the provider's own
    // redirect may turn this into a supplier call.
    case "prebooked":
      return arrival.providerReturn ? "finalize" : "resume";

    case "confirming":
      return "wait";
    case "draft":
    case "failed":
    case "cancelled":
    case "expired":
      return "dead";
  }
}

/**
 * Did the payment provider redirect this browser here?
 *
 * Stripe appends its own parameters to the `return_url` it was given
 * (`src/app/book/[bookingId]/CheckoutClient.tsx` sets that URL): a
 * `payment_intent`, its client secret, and a `redirect_status`. Their PRESENCE
 * is the signal - a browser that simply navigated to this page carries none of
 * them.
 *
 * `redirect_status=failed` is the one value that argues against a charge rather
 * than for one: the provider is saying this attempt did not succeed. Treated as
 * "no charge started", so a declined card leads back to the card step instead of
 * spending a supplier call to be told 2014.
 *
 * Nothing here is trusted as PROOF of payment. It decides one thing only:
 * whether asking the supplier is warranted. The supplier remains the only party
 * that can say whether money moved.
 */
export function isPaymentProviderReturn(params: {
  payment_intent?: string | string[];
  redirect_status?: string | string[];
}): boolean {
  const first = (v: string | string[] | undefined): string =>
    (Array.isArray(v) ? v[0] : v)?.trim() ?? "";

  const status = first(params.redirect_status).toLowerCase();
  if (status === "failed") return false;

  return Boolean(first(params.payment_intent)) || Boolean(status);
}

/** The supplier's rate limit. Silence dressed as an answer. */
const LITEAPI_RATE_LIMITED = 4290;

/**
 * Where a booking goes when the supplier call fails.
 *
 * `failed` IS TERMINAL. Nothing recovers it: the sweeper's rule leaves it alone,
 * `confirmBooking` refuses to re-enter it, and the reconciler does not look at
 * it. So writing `failed` on a booking whose guest may have been charged means
 * that guest is charged and nothing will ever try to book their room again -
 * which is NOS-5's harm, reached through the error path instead of the sweeper.
 *
 * The first version of this fix only special-cased the unpaid refusal and sent
 * everything else to `failed`, including a timeout and a rate limit. The code
 * review caught it, and caught that the test which should have caught it
 * asserted only `not.toBe("expired")` - true of `failed` as well.
 *
 * Two questions decide it, in this order:
 *
 *   1. Could this guest already have paid? If the row was `payment_pending`,
 *      yes, and the answer is never terminal. It returns to `payment_pending`,
 *      where the sweeper keeps working on it and eventually alerts a person
 *      rather than giving up silently.
 *   2. Did the supplier definitively refuse? A structured error code that is
 *      neither "not paid yet" nor "slow down" is a real no - no availability, a
 *      dead prebook, bad data - and for a row where no payment was ever started
 *      that is the end of the booking. No code at all means we never got an
 *      answer: a timeout, a dropped socket, a gateway page. That is not a refusal
 *      and must not be recorded as one.
 */
export function statusAfterFailedBook(
  error: unknown,
  previousStatus: "prebooked" | "payment_pending",
): "prebooked" | "payment_pending" | "failed" {
  // A guest who may have been charged never lands in a terminal state.
  if (previousStatus === "payment_pending") return "payment_pending";

  const code = (error as { code?: unknown } | null)?.code;
  const definitive =
    typeof code === "number" && code !== 2014 && code !== LITEAPI_RATE_LIMITED;

  return definitive ? "failed" : previousStatus;
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
