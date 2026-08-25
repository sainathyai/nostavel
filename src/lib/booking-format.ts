// Pure formatting/parsing helpers pulled out of booking-service.ts so they can
// be unit-tested without pulling in the DB client (which requires a live
// DATABASE_URL just to import).

// Unambiguous alphabet (no 0/O/1/I) for a human-readable booking reference.
const REF_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export function makeRef(): string {
  let s = "";
  for (let i = 0; i < 6; i++) s += REF_ALPHABET[Math.floor(Math.random() * REF_ALPHABET.length)];
  return `NSTVL-${s}`;
}

// LiteAPI nests the cancellation policy at roomTypes[0].rates[0].cancellationPolicies:
//   { refundableTag: "RFN" | "NRFN", cancelPolicyInfos: [{ amount, cancelTime, timezone }] }
// `refundableTag` is NOT used to decide `refundableUntil` — see the long note
// in cancellation.ts's buildCancelPolicy. LiteAPI's own docs say NRFN applies
// if ANY portion is unrefunded and can still refund most of the cost, so the
// ladder is the only honest source; the tag is ignored here entirely. `policy`
// (the whole raw object, tag included) is stored into the ledger's
// cancellationPolicy jsonb regardless, so cancellation.ts can rebuild the full
// ladder from it later — this function only derives one summary column. The
// free window ends at the EARLIEST cancelTime. Times are GMT in
// "YYYY-MM-DD HH:mm:ss" form — not ISO — so we normalize before parsing.
//
// `now` is injectable (conventions.md section 6): the "already past" check
// below is time-dependent, and a fixture date colliding with a hardcoded
// `Date.now()` is exactly how a test goes flaky on its own timeline.
export function extractCancellation(
  pb: unknown,
  now: Date = new Date(),
): {
  policy: object | null;
  refundableUntil: Date | null;
} {
  const p = pb as Record<string, unknown>;
  const roomTypes = p?.roomTypes as Array<Record<string, unknown>> | undefined;
  const rates = roomTypes?.[0]?.rates as Array<Record<string, unknown>> | undefined;
  const policy = (rates?.[0]?.cancellationPolicies ?? null) as Record<string, unknown> | null;
  if (!policy) return { policy: null, refundableUntil: null };

  const infos = policy.cancelPolicyInfos as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(infos) || infos.length === 0) {
    return { policy, refundableUntil: null };
  }

  const times = infos
    .map((i) => i?.cancelTime)
    .filter((t): t is string => typeof t === "string")
    .map((t) => new Date(t.replace(" ", "T") + "Z"))
    .filter((d) => !isNaN(d.getTime()));
  const earliest = times.length ? new Date(Math.min(...times.map((d) => d.getTime()))) : null;
  // A rung already in the past is not a free window — the same "already
  // closed" case buildCancelPolicy guards against, checked here too since
  // this is the value written straight to bookings.refundableUntil.
  const refundableUntil = earliest && earliest.getTime() > now.getTime() ? earliest : null;
  return { policy, refundableUntil };
}
