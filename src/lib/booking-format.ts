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
// `refundableTag` is the authoritative refundable/non-refundable signal; the free
// window ends at the EARLIEST cancelTime (after which a penalty applies). Times are
// GMT in "YYYY-MM-DD HH:mm:ss" form — not ISO — so we normalize before parsing.
export function extractCancellation(pb: unknown): {
  policy: object | null;
  refundableUntil: Date | null;
} {
  const p = pb as Record<string, unknown>;
  const roomTypes = p?.roomTypes as Array<Record<string, unknown>> | undefined;
  const rates = roomTypes?.[0]?.rates as Array<Record<string, unknown>> | undefined;
  const policy = (rates?.[0]?.cancellationPolicies ?? null) as Record<string, unknown> | null;
  if (!policy) return { policy: null, refundableUntil: null };

  const refundableTag = String(policy.refundableTag ?? "").toUpperCase();
  const infos = policy.cancelPolicyInfos as Array<Record<string, unknown>> | undefined;
  if (refundableTag === "NRFN" || !Array.isArray(infos) || infos.length === 0) {
    return { policy, refundableUntil: null };
  }

  const times = infos
    .map((i) => i?.cancelTime)
    .filter((t): t is string => typeof t === "string")
    .map((t) => new Date(t.replace(" ", "T") + "Z"))
    .filter((d) => !isNaN(d.getTime()));
  const refundableUntil = times.length
    ? new Date(Math.min(...times.map((d) => d.getTime())))
    : null;
  return { policy, refundableUntil };
}
