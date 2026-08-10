// Single source of truth for pricing. Applied everywhere a chargeable price is
// computed — search results, the hotel modal, and the actual booking charge —
// so what a signed-in member is SHOWN always matches what they're CHARGED.
// Nobody, member or guest, is ever sold at raw supplier net; we always take a
// margin, and a guest never pays less than a member.
//
// Model: member price = max(SSP * (1 - MEMBER_DISCOUNT_PCT), net * (1 + MIN_MARGIN_PCT))
//   - The SSP-relative discount is the customer-facing pitch ("members save X%
//     off the public rate") and is what actually varies with how inflated a
//     given hotel's SSP is versus its net cost.
//   - The net-relative margin is our profitability FLOOR: it wins whenever the
//     SSP-based discount would cut too close to (or below) cost, e.g. when SSP
//     is only lightly above net, or absent entirely.
// Guest (public/non-member) price = SSP itself when we have one — never
// discounted — else the same margin floor as a fallback (no legal reference to
// price against, so we still protect margin). Never below the member price.
//
// PROVISIONAL constants (2026-08-08), pending a real margin study across
// destinations/seasons/price bands — see project memory. Not tuned per user
// type yet; that's a natural next step once real data exists (e.g. a richer
// `PricingInputs` per persona/tier), but the formula shape is built for it.
export const MEMBER_DISCOUNT_PCT = 0.15; // members save up to ~15% off the public/SSP price
export const MIN_MARGIN_PCT = 0.2; // we never sell below net + 20%

// Unit-agnostic (dollars or minor units) — the caller just needs to be
// consistent — and always rounds to the nearest whole unit.
export function memberPrice(netAmount: number, sspAmount: number | null | undefined): number {
  const floor = Math.round(netAmount * (1 + MIN_MARGIN_PCT));
  if (!sspAmount || sspAmount <= 0) return floor;
  const discounted = Math.round(sspAmount * (1 - MEMBER_DISCOUNT_PCT));
  return Math.max(discounted, floor);
}

// Public (non-member) price: the SSP itself when available, else the same
// margin floor. Always at least the member price (a guest never undercuts a
// member).
export function guestPrice(netAmount: number, sspAmount: number | null | undefined): number {
  const member = memberPrice(netAmount, sspAmount);
  const publicPrice = sspAmount && sspAmount > 0 ? Math.round(sspAmount) : member;
  return Math.max(publicPrice, member);
}
