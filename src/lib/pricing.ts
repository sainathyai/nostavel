// Single source of truth for pricing.
//
// We do not charge the price we compute here. LiteAPI does. We send a `margin`
// percentage on a rates request, LiteAPI marks the net rate up server-side,
// charges the guest through their payment SDK (they are merchant of record),
// and pays us the difference as commission after checkout.
//
// The flow this file supports:
//
//   1. search at margin 0        -> true net cost + any real suggestedSellingPrice
//   2. marginFor() per hotel     -> our margin, from evidence and (later) ranking
//   3. displayPrice()            -> what the guest sees, rounded UP
//   4. at book intent, re-fetch that ONE hotel at that exact margin
//      -> authoritative price + a bookable offerId, compared to what we showed
//
// Two constraints force this shape rather than a simpler one:
//
//   * `margin` is per-REQUEST, not per-offer, and prebook accepts no margin at
//     all (verified against the docs). So a per-hotel margin can only be
//     realised by a request carrying just that hotel.
//   * LiteAPI applies our margin to `suggestedSellingPrice` as well as to the
//     retail rate. Measured live: at margin 30, SSP came back as exactly
//     retail * 1.30 for 52 of 59 hotels. Comparing a priced offer against its
//     own SSP is circular and inflates every savings claim. Only the margin-0
//     SSP means anything.
//
// ---------------------------------------------------------------------------
// WHY SSP IS A CEILING AND NOT A GATE
//
// The previous version of this file treated suggestedSellingPrice as a licence
// to sell: no usable SSP meant marginFor() returned null and the hotel was
// dropped from search entirely. Measured on 38 live Asheville hotels, that
// listed 3 of them. The two candidate explanations were tested separately
// (analysis/yield.py):
//
//   "we only look at the cheapest plan"  -> looking at every plan in the hotel
//                                           still listed 3 of 38. Not the cause.
//   "SSP is being used as a gate"        -> using it purely as a cap listed
//                                           38 of 38, and took commission on
//                                           the cheapest room from $249 to
//                                           $2,328 across the same city.
//
// SSP answers exactly one question: "would advertising this price break rate
// parity with the hotel's public channel?" That is a ceiling. It says nothing
// about whether a room is worth selling — we know net cost either way, so we
// can always price. What we cannot always do is CLAIM A SAVING, and that is
// the thing genuinely gated on evidence. Those two decisions are now separate
// functions: marginFor() always returns a number, compareAtPrice() returns
// null when there is nothing honest to compare against.
// ---------------------------------------------------------------------------

// The band a DISCRETIONARY margin may occupy. Below MIN a booking isn't worth
// processing; above MAX we price above competitors on most of the sample.
// Measured across 788 hotels in six cities, inventory collapses faster than
// per-booking take grows, so a high fixed margin earns more per sale and less
// in total.
//
// This band binds only where WE are choosing a number. It deliberately does NOT
// bind a margin derived from a public rate: charging the hotel's own advertised
// price is at parity by definition, however large the implied markup looks.
// Measured 2026-08-21 across 156 hotels, the margin needed to meet SSP runs to a
// median of 22% and a maximum of 149%, and those are real observations, not bad
// data.
export const MIN_MARGIN_PCT = 5;
export const MAX_MARGIN_PCT = 30;

// ---------------------------------------------------------------------------
// THE TWO PRICES
//
// A signed-in member is charged supplier net plus our member margin. Everyone
// else is charged the PUBLIC rate, and the extra we take is the gap between the
// two. There is no second API call in this: the priced /hotels/rates request
// already happens after the session is known, so membership only changes the
// `margin` VALUE we send. `margin` is per-request, which is why this is decided
// once per hotel rather than per room.
//
// Where a real public rate exists, the non-member margin is DERIVED from it and
// we charge exactly SSP. Where it doesn't, both prices fall back to fixed
// numbers and the gap is our margin difference:
//
//                       real sourced SSP        no public rate
//     member            min(15%, parity)        15%
//     non-member        whatever meets SSP      25%
//
// Measured 2026-08-21, 1292 plans over three cities: the SSP field is NEVER
// absent. It is either sourced (63%, all booking.com) or exactly the 1.15x net
// placeholder (37%) that isRealSsp() rejects.
export const MEMBER_MARGIN_PCT = 15;
export const PUBLIC_MARGIN_PCT = 25;


// When we DO have a public rate to measure against, stay at least this far
// under it. This is the entire purpose of tracking SSP: never advertise at or
// above the hotel's own public price.
export const MIN_VISIBLE_SAVING_PCT = 0.1;

// One margin-0 observation of a single rate plan.
export type RateEvidence = {
  net: number;
  ssp?: number | null;
  /** Where LiteAPI sourced the public rate, e.g. "booking.com". */
  source?: string | null;
};

// LiteAPI's suggestedSellingPrice is a public rate on the same basis as net
// (resort fee in, tax out) — but only sometimes. The rest are a placeholder of
// exactly net * 1.15.
//
// The reliable discriminator is `source`: measured across 11,567 plans, 4,881
// carried source "booking.com" and 6,686 carried none, and the unsourced group
// tracked the 1.15 placeholder almost exactly (6,482). So an unsourced SSP is
// not evidence, whatever its value. The 1.15 check is kept as a belt-and-braces
// second test for the few sourced rows that still carry the placeholder ratio.
export function isRealSsp(ev: RateEvidence): boolean {
  const { net, ssp, source } = ev;
  if (!ssp || ssp <= 0 || !net || net <= 0) return false;
  if (!source || !source.trim()) return false;
  return Math.abs(ssp / net - 1.15) >= 0.005;
}

// Kept for callers that only have the two numbers. Prefer isRealSsp.
export function isSyntheticSsp(net: number, ssp: number | null | undefined): boolean {
  if (!ssp || ssp <= 0 || !net || net <= 0) return true;
  return Math.abs(ssp / net - 1.15) < 0.005;
}

// Everything ranking will eventually want to influence. Deliberately open: the
// current rule uses only the parity ceiling, but the seam is here so a fit
// score, distance, or review weight can raise the margin on a hotel a guest
// clearly wants without the call sites changing.
export type MarginContext = {
  // 0..1, how well this hotel matches what the guest asked for. Higher means
  // we can take more margin and still convert. Absent for now.
  fit?: number;
  /**
   * Is this request being priced for a signed-in member? Decides which of the
   * two prices we ask LiteAPI to charge. Defaults to FALSE: a caller that has
   * not established a session must not be handed member pricing by accident,
   * and being charged the public rate is the safe direction to be wrong in.
   */
  isMember?: boolean;
};

// The margin to request for one hotel. ALWAYS returns a usable number — a
// hotel is never unsellable merely because we cannot prove a saving on it.
//
// `evidence` should be every margin-0 plan we saw for this hotel. Plans without
// a real SSP are ignored rather than counted against the hotel. When at least
// one real SSP exists, the TIGHTEST parity ceiling across them wins, because
// one request's margin applies to every room we then show.
export function marginFor(evidence: RateEvidence[], ctx: MarginContext = {}): number {
  const real = evidence.filter(isRealSsp);
  const isMember = ctx.isMember === true;

  if (!real.length) {
    // No public rate constrains us. Both sides fall back to a fixed number and
    // the tier is simply the difference between them. No saving may be claimed
    // either way, which compareAtPrice() enforces independently.
    const flat = isMember ? MEMBER_MARGIN_PCT : PUBLIC_MARGIN_PCT;
    // Fit only ever lifts a discretionary margin, and only for a member: a
    // non-member is already at the public number, which fit has no claim on.
    const wanted = isMember && ctx.fit != null ? flat * (1 + ctx.fit) : flat;
    return clampMargin(wanted);
  }

  // The margin at which our price lands exactly ON each plan's public rate.
  // The TIGHTEST wins: one request's margin applies to every room we then show,
  // so anything higher would push some room ABOVE its own public price.
  const atParity = Math.min(...real.map((e) => (e.ssp! / e.net - 1) * 100));

  if (!isMember) {
    // Charge the public rate. Deliberately NOT clamped to MAX_MARGIN_PCT: that
    // cap exists to stop us pricing above competitors, and this price IS the
    // competitor's price. Only the floor still applies, since a booking below
    // it is not worth processing.
    return Math.max(MIN_MARGIN_PCT, atParity);
  }

  // A member is held a visible distance under that public rate. Note this is a
  // fraction OF THE PUBLIC RATE, not percentage points of margin: the margin
  // that lands on ssp*(1-MIN_VISIBLE_SAVING_PCT), which is where the original
  // single-tier ceiling sat.
  const ceiling = Math.min(
    ...real.map((e) => ((e.ssp! * (1 - MIN_VISIBLE_SAVING_PCT)) / e.net - 1) * 100),
  );
  const wanted = ctx.fit == null ? MEMBER_MARGIN_PCT : MEMBER_MARGIN_PCT * (1 + ctx.fit);

  // A ceiling below the floor means parity is tighter than our minimum viable
  // take. We still sell — at the floor — but such a hotel must not display a
  // saving. Measured 2026-08-21: about half of the hotels that DO carry a real
  // SSP sit here, because their public rate is already at or under our own
  // price, so a member sees one price and no comparison.
  return clampMargin(Math.min(wanted, ceiling));
}

function clampMargin(pct: number): number {
  if (!Number.isFinite(pct)) return MIN_MARGIN_PCT;
  return Math.max(MIN_MARGIN_PCT, Math.min(pct, MAX_MARGIN_PCT));
}

// The struck-through "compare at" figure, or null when we have not earned the
// right to show one. Two independent conditions, both required:
//   * real, sourced public-rate evidence exists, and
//   * the price we are actually displaying comes in under it.
// Never derive this from a priced (non-zero-margin) response.
export function compareAtPrice(
  displayed: number,
  evidence: RateEvidence[],
): number | null {
  const real = evidence.filter(isRealSsp);
  if (!real.length || !Number.isFinite(displayed) || displayed <= 0) return null;
  // The cheapest public rate is the honest one to quote against; anything
  // higher would flatter our saving.
  const publicRate = Math.min(...real.map((e) => e.ssp!));
  return displayed < publicRate ? publicRate : null;
}

// What the guest sees. Rounded UP so the amount actually charged is never
// higher than the amount displayed: LiteAPI truncates its markup to cents, so
// net * (1 + margin) lands within a cent of what they charge, and ceiling that
// puts the difference in the guest's favour. Showing $180 and charging $180.40
// is the drip-pricing pattern the FTC junk-fee rule targets; showing $180 and
// charging $179.40 is fine.
export function displayPrice(net: number, marginPct: number): number {
  // Settle to cents before ceiling. Without this, 100 * 1.1 evaluates to
  // 110.00000000000001 and a price landing exactly on a dollar is pushed up a
  // whole one — money is never worth carrying binary float error into.
  const cents = Math.round(net * (1 + marginPct / 100) * 100);
  return Math.ceil(cents / 100);
}

// How far under the public rate we land, as a fraction, or null when there is
// no honest comparison. Callers must render a saving only when this is
// non-null — never derive one from a missing or synthetic SSP.
export function savingPct(displayed: number, ssp: number | null | undefined): number | null {
  if (!ssp || ssp <= 0 || !Number.isFinite(displayed) || displayed <= 0) return null;
  if (displayed >= ssp) return null;
  return (ssp - displayed) / ssp;
}

// Guard for the verification step. The price we re-fetch at book intent may
// differ from what we displayed, because supply moves between calls — measured
// at roughly 40% of samples over a few minutes of polling. Anything the guest
// would notice must be surfaced and re-confirmed rather than silently charged.
export function priceMoved(displayed: number, actual: number): boolean {
  // Only an INCREASE is worth interrupting for. Charging less than we quoted
  // needs no permission, and sub-dollar drift downward is the expected result
  // of ceiling the display in the first place.
  return actual > displayed;
}
