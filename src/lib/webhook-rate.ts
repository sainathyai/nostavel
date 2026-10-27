// Rate limiting for the inbound supplier webhook (NOS-13, threat-model gap G2).
//
// Its own module rather than lines inside the route, for two reasons: a route
// file may only export the handler and Next's own config keys, so a helper that
// a test needs to reach cannot live there; and docs/conventions.md §1 keeps the
// decision in src/lib with the route doing the routing.
import { clientIpOf, type RateResult } from "@/lib/rate-limit";
import { rateLimit } from "@/lib/rate-limit-store";

/**
 * Generous on purpose (NOS-13, threat-model gap G2).
 *
 * 60 a minute from one address, which is the figure the threat model itself
 * suggested for LiteAPI's retry cadence. It is a PLACEHOLDER, not a measurement:
 * there is no real delivery traffic to measure against yet (docs/conventions.md
 * §5), and the ticket puts tuning it out of scope.
 *
 * WHICH WAY TO ERR, AND WHY THIS ONE. The two failure directions are not equal.
 * Too loose costs database rows from a flood. Too tight costs a SUPPLIER
 * CANCELLATION: if we refuse a real delivery, a hotel that cancelled on their
 * end stays `confirmed` in our ledger, which is the harm this endpoint exists to
 * prevent. A number far above any plausible legitimate burst still bounds the
 * flood, so the limit is deliberately not tight.
 *
 * AND AN UNKNOWN, STATED RATHER THAN ASSUMED AWAY: LiteAPI documents
 * at-least-once delivery with exponential backoff, but not whether a 429 counts
 * as retryable to them. If it does not, a limited delivery is lost rather than
 * delayed. What bounds that today is this limit being far above their cadence,
 * and the nightly reconciler (src/app/api/cron/reconcile/route.ts), which
 * compares our confirmed bookings against the supplier and would surface a
 * cancellation we never applied within a day.
 */
const WEBHOOK_RATE = { limit: 60, windowMs: 60_000 };

type WebhookRateOptions = typeof WEBHOOK_RATE & { onStoreError: "allow" | "deny" };

/**
 * FAILS OPEN, which is the opposite of what the money-path actions do.
 *
 * Everywhere a guest spends money we would rather refuse than risk a double
 * charge. Here the job is not to refuse: it is to not lose what the supplier is
 * telling us. A limiter outage that silently dropped supplier cancellations
 * would be a worse outcome than an unlimited minute of inserts, so an error in
 * the limiter lets the request through and says so in the log.
 *
 * Nothing in today's path can actually throw - the limiter is a synchronous map
 * lookup - so `limiter` is injectable to make this branch reachable from a test
 * rather than asserted in a comment. NOS-10 replaces that map with a shared
 * store, at which point the branch stops being hypothetical and this call site
 * needs only `await`.
 */
export async function checkWebhookRate(
  request: Request,
  limiter: (key: string, opts: WebhookRateOptions) => Promise<RateResult> = rateLimit,
): Promise<RateResult> {
  try {
    return await limiter(`webhook-liteapi:ip:${clientIpOf(request)}`, {
      ...WEBHOOK_RATE,
      // The only `allow` in the codebase, for the reason above: refusing a real
      // delivery is the harm here, not admitting one too many.
      onStoreError: "allow",
    });
  } catch (e) {
    // Belt and braces. `rateLimit` already turns a store error into its policy
    // rather than a throw, so reaching this means something unforeseen - and
    // the direction is the same either way: let the delivery through.
    console.warn(
      "[webhook] rate limiter unavailable, allowing the delivery:",
      (e as Error).message,
    );
    return { ok: true, remaining: 0, retryAfterMs: 0 };
  }
}
