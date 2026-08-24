import { describe, it, expect } from "vitest";
import {
  marginFor,
  displayPrice,
  compareAtPrice,
  isRealSsp,
  savingPct,
  priceMoved,
  MIN_MARGIN_PCT,
  MAX_MARGIN_PCT,
  MEMBER_MARGIN_PCT,
  PUBLIC_MARGIN_PCT,
  MIN_VISIBLE_SAVING_PCT,
  type RateEvidence,
} from "./pricing";

// Figures below are real margin-0 observations captured in analysis/.
const SOURCED = (net: number, ssp: number): RateEvidence => ({ net, ssp, source: "booking.com" });
/** The ssp/net == 1.15 placeholder, which arrives with no source. */
const PLACEHOLDER = (net: number): RateEvidence => ({ net, ssp: net * 1.15, source: "" });

const NOLA = SOURCED(349.06, 491.98);
const CAMBRIA = SOURCED(262.64, 270.27); // only a 2.9% spread

describe("isRealSsp", () => {
  it("requires a named source", () => {
    expect(isRealSsp(SOURCED(349.06, 491.98))).toBe(true);
    expect(isRealSsp({ net: 349.06, ssp: 491.98, source: "" })).toBe(false);
    expect(isRealSsp({ net: 349.06, ssp: 491.98, source: null })).toBe(false);
  });

  it("rejects the 1.15 placeholder even if a source is claimed", () => {
    expect(isRealSsp({ net: 300, ssp: 345, source: "booking.com" })).toBe(false);
  });

  it("rejects missing or nonsense numbers", () => {
    expect(isRealSsp({ net: 0, ssp: 100, source: "booking.com" })).toBe(false);
    expect(isRealSsp({ net: 100, ssp: null, source: "booking.com" })).toBe(false);
  });
});

// The member tier. `marginFor` defaults to the PUBLIC side when no context is
// given, so every member expectation below says so explicitly -- that default
// is deliberate and is itself asserted.
const MEMBER = { isMember: true } as const;

describe("marginFor — two prices, one request", () => {
  it("defaults to the PUBLIC tier when no session is supplied", () => {
    // A caller that has not established a session must never be handed member
    // pricing by accident. Being charged the public rate is the recoverable
    // direction to be wrong in; the reverse is a revenue leak.
    expect(marginFor([PLACEHOLDER(300)])).toBe(PUBLIC_MARGIN_PCT);
    expect(marginFor([PLACEHOLDER(300)], {})).toBe(PUBLIC_MARGIN_PCT);
    expect(marginFor([PLACEHOLDER(300)], { isMember: false })).toBe(PUBLIC_MARGIN_PCT);
  });

  it("falls back to fixed numbers when there is no public rate to meet", () => {
    // Measured 2026-08-21: 37% of plans carry only the 1.15x placeholder, so
    // this branch prices roughly a third of real inventory.
    expect(marginFor([PLACEHOLDER(300)], MEMBER)).toBe(MEMBER_MARGIN_PCT);
    expect(marginFor([PLACEHOLDER(300)])).toBe(PUBLIC_MARGIN_PCT);
    expect(marginFor([{ net: 300, ssp: null, source: null }], MEMBER)).toBe(MEMBER_MARGIN_PCT);
  });

  it("charges a NON-member exactly the public rate", () => {
    // NOLA: net 349.06, public 491.98. The margin that lands on the public
    // rate is 40.9%, well past MAX_MARGIN_PCT -- and that cap must NOT bind
    // here, because this price IS the competitor's price, not one we chose.
    const m = marginFor([NOLA]);
    expect(displayPrice(NOLA.net, m)).toBeCloseTo(NOLA.ssp!, 0);
    expect(m).toBeGreaterThan(MAX_MARGIN_PCT);
  });

  it("holds a MEMBER a visible distance under that public rate", () => {
    const m = marginFor([NOLA], MEMBER);
    expect(m).toBe(MEMBER_MARGIN_PCT);
    const shown = displayPrice(NOLA.net, m);
    expect(shown).toBeLessThan(NOLA.ssp!);
    expect(compareAtPrice(shown, [NOLA])).toBe(NOLA.ssp);
  });

  it("always leaves the member cheaper than the public price", () => {
    for (const ev of [[NOLA], [SOURCED(200, 320)], [SOURCED(100, 118)], [PLACEHOLDER(300)]]) {
      const member = displayPrice(ev[0].net, marginFor(ev, MEMBER));
      const publicPrice = displayPrice(ev[0].net, marginFor(ev));
      expect(member).toBeLessThanOrEqual(publicPrice);
    }
  });

  it("still sells a hotel whose spread is too thin to show a saving", () => {
    // CAMBRIA: 262.64 -> 270.27, a 2.9% spread, thinner than our floor. Both
    // tiers land on the floor and neither may claim a saving.
    expect(marginFor([CAMBRIA], MEMBER)).toBe(MIN_MARGIN_PCT);
    expect(marginFor([CAMBRIA])).toBe(MIN_MARGIN_PCT);
    expect(compareAtPrice(displayPrice(CAMBRIA.net, MIN_MARGIN_PCT), [CAMBRIA])).toBeNull();
  });

  it("never returns null or a non-finite number, on either tier", () => {
    for (const ev of [[], [PLACEHOLDER(200)], [NOLA], [CAMBRIA]]) {
      for (const ctx of [MEMBER, {}]) {
        const m = marginFor(ev, ctx);
        expect(Number.isFinite(m)).toBe(true);
        expect(m).toBeGreaterThanOrEqual(MIN_MARGIN_PCT);
      }
    }
  });

  it("caps only the DISCRETIONARY margin at MAX_MARGIN_PCT", () => {
    // A member margin is a number we chose, so the band binds.
    for (const ev of [[], [PLACEHOLDER(200)], [NOLA], [CAMBRIA]]) {
      expect(marginFor(ev, MEMBER)).toBeLessThanOrEqual(MAX_MARGIN_PCT);
    }
    // A public margin is read off the public rate, so it does not.
    expect(marginFor([NOLA])).toBeGreaterThan(MAX_MARGIN_PCT);
  });

  it("takes the TIGHTEST plan when they disagree, on both tiers", () => {
    // One margin covers every room on the page, so the most constrained plan
    // has to govern or we would advertise above a public rate on that room.
    expect(marginFor([NOLA, CAMBRIA], MEMBER)).toBe(marginFor([CAMBRIA], MEMBER));
    expect(marginFor([NOLA, CAMBRIA])).toBe(marginFor([CAMBRIA]));
    expect(marginFor([NOLA, CAMBRIA])).toBeLessThan(marginFor([NOLA]));
  });

  it("ignores unsourced plans rather than letting them drag the ceiling down", () => {
    expect(marginFor([NOLA, PLACEHOLDER(349.06)], MEMBER)).toBe(marginFor([NOLA], MEMBER));
    expect(marginFor([NOLA, PLACEHOLDER(349.06)])).toBe(marginFor([NOLA]));
  });

  it("lets fit raise a member margin but never past the parity ceiling", () => {
    expect(marginFor([NOLA], { ...MEMBER, fit: 1 })).toBeGreaterThan(marginFor([NOLA], MEMBER));
    expect(marginFor([NOLA], { ...MEMBER, fit: 1 })).toBeLessThanOrEqual(MAX_MARGIN_PCT);
  });

  it("does not let fit move a NON-member price", () => {
    // A non-member is already at the public number. Fit has no claim on it,
    // and letting it push higher would price us ABOVE the public rate.
    expect(marginFor([NOLA], { fit: 1 })).toBe(marginFor([NOLA]));
    expect(marginFor([PLACEHOLDER(300)], { fit: 1 })).toBe(PUBLIC_MARGIN_PCT);
  });
});

describe("compareAtPrice — the claim, gated separately from the price", () => {
  it("shows nothing without sourced evidence", () => {
    expect(compareAtPrice(300, [PLACEHOLDER(300)])).toBeNull();
    expect(compareAtPrice(300, [])).toBeNull();
  });

  it("shows nothing when we do not actually beat the public rate", () => {
    expect(compareAtPrice(500, [NOLA])).toBeNull(); // 500 > 491.98
    expect(compareAtPrice(491.98, [NOLA])).toBeNull(); // equal is not a saving
  });

  it("quotes the CHEAPEST public rate so the saving is never flattered", () => {
    const ev = [SOURCED(300, 400), SOURCED(310, 500)];
    expect(compareAtPrice(350, ev)).toBe(400);
  });

  it("a thin-spread hotel sells but shows no strikethrough", () => {
    const m = marginFor([CAMBRIA], { isMember: true });
    const shown = displayPrice(CAMBRIA.net, m);
    // It is sellable...
    expect(shown).toBeGreaterThan(0);
    // ...but at the floor margin it lands above the public rate, so no claim.
    expect(compareAtPrice(shown, [CAMBRIA])).toBeNull();
  });
});

describe("the two decisions together", () => {
  it("whenever a comparison IS shown, the guest genuinely saves", () => {
    const cases: RateEvidence[][] = [[NOLA], [SOURCED(200, 320)], [SOURCED(1000, 1400)]];
    for (const ev of cases) {
      const shown = displayPrice(ev[0].net, marginFor(ev, { isMember: true }));
      const compare = compareAtPrice(shown, ev);
      if (compare !== null) {
        expect(shown).toBeLessThan(compare);
        expect(savingPct(shown, compare)).toBeGreaterThan(0);
      }
    }
  });

  it("respects the minimum visible saving when the ceiling binds", () => {
    // A hotel where the ceiling, not the member rate, decides: public 118 on
    // net 100, so the ceiling is 118*0.9/100 - 1 = 6.2%, under the 15% member
    // margin, and binds.
    const ev = [SOURCED(100, 118)];
    const m = marginFor(ev, { isMember: true });
    expect(m).toBeLessThan(MEMBER_MARGIN_PCT);
    expect(displayPrice(100, m)).toBeLessThanOrEqual(118 * (1 - MIN_VISIBLE_SAVING_PCT) + 1);
  });
});

describe("displayPrice", () => {
  it("never charges more than it shows", () => {
    for (const net of [100, 349.06, 262.64, 1234.56]) {
      for (const m of [5, 12, 17.5, 30]) {
        // Compare against the cent-settled charge, which is what LiteAPI
        // actually bills. Comparing against the raw product would fail on
        // binary error alone: 100 * 1.12 is 112.00000000000001.
        const charged = Math.round(net * (1 + m / 100) * 100) / 100;
        expect(displayPrice(net, m)).toBeGreaterThanOrEqual(charged);
      }
    }
  });

  it("does not push a whole-dollar result up by binary float error", () => {
    // 100 * 1.1 is 110.00000000000001 in IEEE 754; a naive ceil returns 111.
    expect(displayPrice(100, 10)).toBe(110);
  });
});

describe("priceMoved", () => {
  it("interrupts only on an increase", () => {
    expect(priceMoved(200, 201)).toBe(true);
    expect(priceMoved(200, 200)).toBe(false);
    expect(priceMoved(200, 199.4)).toBe(false);
  });
});
