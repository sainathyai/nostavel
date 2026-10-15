// What a supplier webhook actually means for a booking (NOS-8).
//
// THE BUG THIS REPLACES. The dispatcher routed BOTH `booking.cancel` and
// `booking.refund` to `recordSupplierCancellation`, which unconditionally sets
// `status: "cancelled"`. So a partial or goodwill refund on a stay that is still
// going ahead marked the booking cancelled in our own ledger: the guest's trip
// page showed a live stay as cancelled, and reconciliation against the weekly
// payout was wrong for that booking. Threat-model gap G6.
//
// WHY THE EVENT NAME IS NOT THE ANSWER. The obvious fix is "cancel means cancel,
// refund means refund", and it is wrong. The supplier sends `booking.refund` with
// a status of `CANCELLED_WITH_CHARGES` for a cancellation that kept some money -
// there is an integration test asserting exactly that shape, and it expects a
// cancellation. The supplier's own reported status is the better evidence about
// what happened to the booking, and the event name is only a fallback for when
// the payload carries no status at all.
//
// So this is a pure rule over two inputs, which means it can be exhaustively
// tested without a database, a network or a clock. The dispatcher's job becomes
// routing, not interpretation.

/** What the webhook means for the booking. */
export type WebhookIntent =
  /** The booking is off at the supplier. Cancel ours and record what came back. */
  | "cancellation"
  /** Money came back on a booking that is still going ahead. Record it only. */
  | "refund"
  /** Nothing for us to write beyond the stored `webhook_events` row. */
  | "ignore";

/**
 * Supplier statuses that mean the booking itself is cancelled.
 *
 * Taken from the shapes the supplier is known to send rather than invented:
 * `CANCELLED` and the `CANCELLED_WITH_CHARGES` variant that appears on a
 * refund event (see `route.int.test.ts`). Compared case-insensitively and with
 * surrounding space trimmed, because this is a free-text field from someone
 * else's system.
 *
 * Deliberately a prefix test on `CANCELLED`, not an exact list: the supplier has
 * already shown it appends qualifiers (`_WITH_CHARGES`), and treating an
 * unrecognised `CANCELLED_SOMETHING_ELSE` as "not cancelled" would leave our
 * ledger claiming a live stay the supplier has ended. Erring toward cancelled on
 * a status that says cancelled is the safer direction: it matches what the
 * supplier says, and the guest sees the truth.
 */
function saysCancelled(supplierStatus: string | null | undefined): boolean {
  const s = (supplierStatus ?? "").trim().toUpperCase();
  return s.startsWith("CANCELLED") || s.startsWith("CANCELED");
}

/**
 * Decide what to do about a webhook.
 *
 * `supplierStatus` wins when it speaks. The event name is the fallback.
 */
export function webhookIntent(args: {
  eventName: string | null | undefined;
  supplierStatus: string | null | undefined;
}): WebhookIntent {
  const name = (args.eventName ?? "").trim();
  if (name !== "booking.cancel" && name !== "booking.refund") return "ignore";

  // A cancel event whose payload says cancelled, or says nothing, is a
  // cancellation. A `booking.cancel` carrying a status that is NOT cancelled is
  // contradictory; we follow the supplier's status, because that is the field
  // describing the booking rather than the message.
  if (name === "booking.cancel") {
    const s = (args.supplierStatus ?? "").trim();
    if (s === "") return "cancellation";
    return saysCancelled(s) ? "cancellation" : "refund";
  }

  // `booking.refund`: a cancellation only if the supplier says the booking is
  // cancelled. Otherwise money came back on a stay that is still happening.
  return saysCancelled(args.supplierStatus) ? "cancellation" : "refund";
}

/**
 * The `booking_events` type to record, derived rather than hardcoded.
 *
 * The old code always wrote `webhook.booking.cancel` whichever event triggered
 * it, so a refund was mislabelled in the audit trail as well as in the booking's
 * status. The audit trail is the thing the reconciler and a human both read, so a
 * wrong label there is a wrong answer twice.
 */
export function webhookEventType(intent: Exclude<WebhookIntent, "ignore">): string {
  return intent === "cancellation" ? "webhook.booking.cancel" : "webhook.booking.refund";
}
