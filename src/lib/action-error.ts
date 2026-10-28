// What a guest is told when something breaks, and what the log keeps (NOS-11).
//
// THE BUG THIS REPLACES. Four of the five booking actions and the
// `/api/stays-in-area` route ended with `return { ok: false, error: (e as
// Error).message }`. That message is whatever was thrown, which includes:
//
//   - LiteAPI's own response text, via `LiteApiError` (`LiteAPI 400: booking
//     incomplete`), so the supplier's wording and status reached the browser;
//   - internal state detail, e.g. `Booking is not open for guest details
//     (status: payment_pending)`, which tells a stranger our status vocabulary;
//   - `LITEAPI_KEY missing. Add it to .env.local`, an instruction to an
//     operator, shown to a guest, if a key is ever unset in an environment.
//
// And none of it was logged anywhere, so an operator hearing "it said something
// about a booking being incomplete" had nothing to search.
//
// WIDER THAN THE TICKET, DELIBERATELY. NOS-11 named five call sites. Grepping
// `.message` across src/app found four more of the same defect, two of them on
// the money path: `confirmation/page.tsx` rendered `confirmBooking`'s thrown
// text straight into the page (its two sibling branches use static copy, so it
// was plainly an oversight), `page.tsx` passed a thrown search error to a client
// component as `searchError`, and the `hotel-images` / `hotel-preview` routes
// relay the supplier's text like `stays-in-area` did. Fixing the action while
// leaving the page that mirrors it would have left the common path leaking.
//
// TWO USES OF `.message` ARE LEFT ALONE, both on purpose:
//   - `api/cron/reconcile/route.ts` puts thrown messages in its response body.
//     That body goes to Cloud Scheduler and an operator reading logs, never to a
//     guest, and the detail is the point of it.
//   - `CheckoutClient.tsx` shows the payment provider's own client-side message.
//     That text is written for cardholders by the provider, it never passes
//     through our server, and replacing it with our own copy would tell a guest
//     less about their own declined card.
//
// THE CONTRACT HERE. The guest gets fixed copy plus a short reference. The log
// gets the raw detail plus the SAME reference. That pairing is the whole point:
// a safe message with nothing to correlate is just a worse error message
// (`.agents/rules/security.md`: "the guest gets a safe message; the detail goes
// to the server log").
//
// WHAT THIS IS NOT. Not a request id: the reference joins one guest's report to
// one log line and identifies nothing else. It WAS also "not structured
// logging", which NOS-69 since made false - the line is built by `log.ts`, so
// `scope` and `reference` are fields a metric can count, and the sentence a
// human reads is the same string either way.

import { reportFields, reportedMessage } from "./error-report";
import { logLine, writeLine } from "./log";
import { redactPersonalData } from "./redact";

/** Which failure the guest is looking at. The copy differs because the truth does. */
export type FailureScope =
  | "prepare"
  | "guest"
  | "payment"
  | "confirm"
  | "cancel"
  | "search"
  | "area-search"
  | "hotel-extras";

/**
 * Guest-facing copy, one message per scope, with no supplier or internal detail.
 *
 * WHY NOT ONE GENERIC MESSAGE FOR ALL SIX. Because the messages make claims, and
 * the true claim is different in each case (`docs/conventions.md` §4: every
 * guest-facing claim needs a source). Specifically:
 *
 * - **prepare** can promise no charge. Nothing has been taken at that point: the
 *   payment provider bills the card later, client-side, at checkout.
 * - **confirm** must NOT promise that. The guest's card is charged in the browser
 *   BEFORE this call, so a failure here is exactly the case where money may have
 *   moved and the booking did not complete. It tells them not to pay twice,
 *   which is advice, and makes no promise about what we will do, because the
 *   thing that would keep such a promise (someone reading `payment.unresolved`)
 *   is still open as NOS-56.
 * - **cancel** must not say "nothing changed" either. The supplier is called
 *   before we write, so a failed cancellation can mean the hotel cancelled and
 *   our ledger did not record it. That is the divergence NOS-7 named and left to
 *   the reconciler, and telling a guest their booking is untouched would be a
 *   guess. So it says to check with us before trying again.
 */
export function guestMessage(scope: FailureScope, reference: string): string {
  switch (scope) {
    case "prepare":
      return `We could not hold that room. Nothing has been charged. Try again, or choose another room. If it keeps happening, quote reference ${reference}.`;
    case "guest":
      return `We could not save those details. Try again, and quote reference ${reference} if it keeps happening.`;
    case "payment":
      return `We could not update your booking just now. Carry on, and quote reference ${reference} if anything looks wrong afterwards.`;
    case "confirm":
      return `We could not finish your booking. If your card was charged, do not pay again. Contact us with reference ${reference} and we will sort it out.`;
    case "cancel":
      return `We could not complete your cancellation. Contact us with reference ${reference} before trying again, in case the hotel has already cancelled it.`;
    case "search":
      return `We could not search for stays just now. Try again in a moment, and quote reference ${reference} if it keeps happening.`;
    case "area-search":
      return `We could not search that area. Try again in a moment, and quote reference ${reference} if it keeps happening.`;
    case "hotel-extras":
      return `Some details for this stay could not be loaded. Reference ${reference}.`;
  }
}

/** How many `cause` links to follow. A chain longer than this is a bug of its own. */
const MAX_CAUSE_DEPTH = 5;
/** A log line is for reading. Anything longer than this is a dump, not a message. */
const MAX_DETAIL_CHARS = 2000;

/**
 * A loggable description of anything that was thrown. Never throws itself.
 *
 * Must handle a non-`Error` throw, because `throw "nope"` and a rejected promise
 * with no reason are both legal and both used to arrive here as `undefined` on
 * `(e as Error).message`. Follows the `cause` chain, because the useful sentence
 * is often the inner one, and guards against a self-referencing cause rather
 * than trusting that nobody will build one.
 */
export function describeThrown(e: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = e;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current != null; depth += 1) {
    if (seen.has(current)) {
      parts.push("[circular cause]");
      break;
    }
    seen.add(current);
    parts.push(describeOne(current));
    current = current instanceof Error ? (current.cause ?? null) : null;
  }

  const joined = parts.length ? parts.join(" <- ") : describeOne(e);
  const redacted = redactPersonalData(joined);
  return redacted.length > MAX_DETAIL_CHARS
    ? `${redacted.slice(0, MAX_DETAIL_CHARS)}... [truncated]`
    : redacted;
}

function describeOne(value: unknown): string {
  try {
    if (value instanceof Error) {
      const name = value.name || "Error";
      const message = value.message || "(no message)";
      return `${name}: ${message}`;
    }
    if (typeof value === "string") return `thrown string: ${value}`;
    if (value === undefined) return "thrown undefined";
    if (value === null) return "thrown null";
    return `thrown ${typeof value}: ${String(value)}`;
  } catch {
    // A value whose own `toString` throws. It exists, and this function
    // promising never to throw is more useful than its description.
    return "thrown value that could not be described";
  }
}

/**
 * The reference the guest quotes and the operator greps for.
 *
 * Eight hex characters from a UUID, not the whole UUID: a guest reads this out
 * or types it into a form. It is not a request id and does not identify the
 * booking; it exists only to join one guest's report to one log line.
 */
export function newReference(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
}

export type FailureReport = {
  /** The id in both the guest's message and the log line. */
  reference: string;
  /** Safe to show a guest. */
  error: string;
};

/**
 * Log the detail, return the safe message. The one call every catch block makes.
 *
 * `reference` and `log` are injectable so a test can assert the exact pairing
 * (the same id in both places) without reading a real clock or a real console.
 */
export function reportFailure(
  scope: FailureScope,
  thrown: unknown,
  deps: { reference?: string; log?: (line: string) => void } = {},
): FailureReport {
  const reference = deps.reference ?? newReference();
  const log = deps.log ?? ((line: string) => writeLine("ERROR", line));
  // One line, one string: `grep REF123` has to find it, and a line split across
  // console.error arguments is not greppable in Cloud Logging. Since NOS-69 that
  // one string is JSON, so `scope` and `reference` are fields a filter can key
  // on as well as text a human can read.
  // AND REPORTED, not only logged (NOS-70). The same fault on twenty bookings
  // was twenty unrelated lines; with the report fields it is one group with a
  // count, a first-seen, and the guest's `reference` on it - so the id they
  // quote on the phone finds the group and not just the one line.
  const headline = `${scope} failed, reference ${reference}: ${describeThrown(thrown)}`;
  log(
    logLine(
      "ERROR",
      "action.failed",
      reportedMessage(headline, thrown),
      reportFields("action.failed", thrown, { scope, reference }),
    ),
  );
  return { reference, error: guestMessage(scope, reference) };
}
