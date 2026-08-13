import { describe, it, expect } from "vitest";
import { memberPrice, guestPrice, MEMBER_DISCOUNT_PCT, MIN_MARGIN_PCT } from "./pricing";

describe("memberPrice", () => {
  it("uses the margin floor when there is no SSP", () => {
    expect(memberPrice(10000, null)).toBe(Math.round(10000 * (1 + MIN_MARGIN_PCT)));
    expect(memberPrice(10000, undefined)).toBe(Math.round(10000 * (1 + MIN_MARGIN_PCT)));
  });

  it("uses the margin floor when SSP is zero or negative", () => {
    expect(memberPrice(10000, 0)).toBe(Math.round(10000 * 1.2));
    expect(memberPrice(10000, -50)).toBe(Math.round(10000 * 1.2));
  });

  it("uses the SSP-relative discount when it clears the margin floor", () => {
    // net 10000, ssp 20000 -> discounted 17000, floor 12000 -> discounted wins
    expect(memberPrice(10000, 20000)).toBe(Math.round(20000 * (1 - MEMBER_DISCOUNT_PCT)));
  });

  it("falls back to the margin floor when the SSP discount would cut below it", () => {
    // net 10000, ssp only 10500 (5% above net) -> discounted 8925 < floor 12000
    const result = memberPrice(10000, 10500);
    expect(result).toBe(Math.round(10000 * 1.2));
    expect(result).toBeGreaterThan(Math.round(10500 * (1 - MEMBER_DISCOUNT_PCT)));
  });

  it("rounds to the nearest whole unit", () => {
    expect(Number.isInteger(memberPrice(9999, 15001))).toBe(true);
  });
});

describe("guestPrice", () => {
  it("equals the SSP when SSP is present and above the member price", () => {
    // net 10000, ssp 20000 -> member 17000, guest = ssp = 20000
    expect(guestPrice(10000, 20000)).toBe(20000);
  });

  it("never charges a guest less than a member", () => {
    // net 10000, ssp 10500 -> member floor 12000; guest must not be 10500
    const member = memberPrice(10000, 10500);
    const guest = guestPrice(10000, 10500);
    expect(guest).toBeGreaterThanOrEqual(member);
  });

  it("falls back to the member price when there is no SSP", () => {
    expect(guestPrice(10000, null)).toBe(memberPrice(10000, null));
  });

  it("falls back to the member price when SSP is non-positive", () => {
    expect(guestPrice(10000, 0)).toBe(memberPrice(10000, 0));
    expect(guestPrice(10000, -1)).toBe(memberPrice(10000, -1));
  });
});
