// What a guest actually loses by cancelling, and when.
//
// TWO THINGS WERE WRONG BEFORE THIS FILE EXISTED.
//
// 1. THE DEADLINE WAS SHOWN IN GMT. LiteAPI returns every cancelTime as a bare
//    "YYYY-MM-DD HH:mm:ss" with a sibling `timezone` field, and measured across
//    255 tier entries in one hotel that field was "GMT" every single time. We
//    were formatting it in UTC, so a deadline of 2026-09-28 01:00 GMT rendered
//    as "Sep 28" to a guest in Austin for whom it expires at 8pm on Sep 27.
//    Booking.com and Expedia both show property-local time; a date that reads a
//    day later than the truth is the worst possible direction for that error.
//
//    LiteAPI publishes no property timezone (checked /data/hotel: absent), so it
//    is derived from the coordinates we already hold, offline, via tz-lookup.
//
// 2. ONLY THE FIRST TIER WAS READ. `cancelPolicyInfos` is a LADDER: each entry
//    says "from this instant, cancelling costs this much". Free cancellation is
//    the window BEFORE the first entry. Measured on one hotel's 1000 plans:
//    802 had no tiers (NRFN), 141 had one, and 57 had TWO — e.g. free until
//    Sep 28, then $189.92, then the full $379.84 from Oct 12. Collapsing that
//    to "Free until Sep 28" told the guest nothing about the middle rung, and
//    the middle rung is the guest-favourable part: half the stay is still
//    refundable for another fortnight.

import tzlookup from "tz-lookup";

export type CancelTier = {
  /** ISO instant the penalty starts applying. */
  from: string;
  /** "Sep 28, 8:00 PM CDT" — property-local. */
  fromLabel: string;
  /** What cancelling costs from `from` onward, in the rate's currency. */
  amount: number;
  /** amount as a share of the total charged, for "50% of your stay". */
  share: number;
};

export type CancelPolicy = {
  /** A free window exists AND has not already closed. */
  refundable: boolean;
  /** Short chip form, property-local: "Sep 28". Null when never refundable. */
  freeUntilShort: string | null;
  /** Full form with time and zone: "Sep 27, 8:00 PM CDT". */
  freeUntilLong: string | null;
  /** Penalty rungs after the free window, cheapest first. May be empty. */
  tiers: CancelTier[];
  /** IANA zone the labels are rendered in, or null when we could not derive one. */
  zone: string | null;
};

export type RawCancelPolicies = {
  refundableTag?: string | null;
  cancelPolicyInfos?:
    | {
        cancelTime?: string;
        amount?: number;
        currency?: string;
        type?: string;
        timezone?: string;
      }[]
    | null;
};

/**
 * The IANA zone for a property, from coordinates. Null when we have no
 * coordinates — every caller then falls back to UTC labels, which is what we
 * did before and is still better than nothing.
 */
export function zoneFor(lat: number | null | undefined, lng: number | null | undefined) {
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  try {
    return tzlookup(lat, lng);
  } catch {
    // tz-lookup throws on out-of-range coordinates rather than returning null.
    return null;
  }
}

/**
 * LiteAPI's "2026-09-28 01:00:00" plus its stated zone, as a real instant.
 *
 * The stated zone has been GMT in every observation, so that is the only case
 * handled exactly; anything else is treated as GMT too rather than guessed at,
 * because silently reading a non-GMT stamp as GMT and silently reading it as
 * local are both wrong and only the first is consistent with what we have seen.
 */
function toInstant(cancelTime: string | undefined): Date | null {
  if (!cancelTime) return null;
  const d = new Date(cancelTime.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmt(d: Date, zone: string | null, withTime: boolean) {
  const opts: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    timeZone: zone ?? "UTC",
  };
  if (withTime) {
    opts.hour = "numeric";
    opts.minute = "2-digit";
    // Names the zone the guest is being held to. Without it "Sep 27, 8:00 PM"
    // reads as the guest's own clock, which is the bug this file exists to fix.
    opts.timeZoneName = "short";
  }
  return new Intl.DateTimeFormat("en-US", opts).format(d);
}

/**
 * Build the display policy for one rate.
 *
 * `total` is what the guest is charged (rate only), used to express each rung
 * as a share. Pass the same figure that is shown as the price, so "50% of your
 * stay" is 50% of the number on the page.
 *
 * `now` is injectable so the free-window-already-closed branch is testable.
 */
export function buildCancelPolicy(
  raw: RawCancelPolicies | null | undefined,
  total: number,
  zone: string | null,
  now: Date = new Date(),
): CancelPolicy {
  const infos = (raw?.cancelPolicyInfos ?? []).filter((i) => i?.cancelTime);

  // The `refundableTag` is NOT used to decide anything here. LiteAPI's own
  // docs say NRFN applies if ANY portion of a booking is unrefunded, and an
  // NRFN-tagged rate "still may refund most of the cost" — the ladder below
  // is the only honest source for what a guest actually loses. An earlier
  // version short-circuited on `refundableTag === "NRFN"` and discarded
  // `cancelPolicyInfos` unread, which told guests a partially-refundable rate
  // could not be refunded at all. cancellationPolicy is stored raw in the
  // ledger regardless, so nothing here needed a backfill — only this read.
  //
  // No ladder at all is how a true non-refundable rate arrives: nothing is
  // ever free, and there is no rung to show because the penalty is simply the
  // whole stay from the moment of booking.
  if (infos.length === 0) {
    return { refundable: false, freeUntilShort: null, freeUntilLong: null, tiers: [], zone };
  }

  const tiers: CancelTier[] = [];
  for (const i of infos) {
    const from = toInstant(i.cancelTime);
    const amount = typeof i.amount === "number" ? i.amount : null;
    if (!from || amount === null) continue;
    tiers.push({
      from: from.toISOString(),
      fromLabel: fmt(from, zone, true),
      amount,
      share: total > 0 ? amount / total : 0,
    });
  }
  tiers.sort((a, b) => a.from.localeCompare(b.from));

  if (!tiers.length) {
    return { refundable: false, freeUntilShort: null, freeUntilLong: null, tiers: [], zone };
  }

  // The free window ends where the first penalty begins. A rate can be tagged
  // RFN and still have that moment already behind us — a stay booked inside the
  // cancellation window — and calling that "free cancellation" would be a lie.
  const firstPenalty = new Date(tiers[0].from);
  if (firstPenalty.getTime() <= now.getTime()) {
    return { refundable: false, freeUntilShort: null, freeUntilLong: null, tiers, zone };
  }

  return {
    refundable: true,
    freeUntilShort: fmt(firstPenalty, zone, false),
    freeUntilLong: fmt(firstPenalty, zone, true),
    tiers,
    zone,
  };
}

/**
 * The ladder as sentences, for rendering under a rate. Empty when there is
 * nothing beyond "free until X" worth saying — a single rung that charges the
 * whole stay is already implied by the deadline.
 */
export function describeTiers(policy: CancelPolicy, currency = "USD"): string[] {
  if (!policy.tiers.length) return [];
  const money = (n: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(n);

  // One rung that takes ~everything says no more than the deadline does.
  if (policy.tiers.length === 1 && policy.tiers[0].share >= 0.99) return [];

  return policy.tiers.map((t, idx) => {
    const pct = Math.round(t.share * 100);
    const cost =
      t.share >= 0.99 ? `you lose the full ${money(t.amount)}` : `you lose ${money(t.amount)} (${pct}%)`;
    const until = policy.tiers[idx + 1] ? ` until ${policy.tiers[idx + 1].fromLabel}` : "";
    return `From ${t.fromLabel}${until}, ${cost}.`;
  });
}
