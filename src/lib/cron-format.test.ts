import { describe, it, expect } from "vitest";
import { cutoffFor, statusesAgree } from "./cron-format";

describe("cutoffFor", () => {
  it("subtracts the TTL in minutes from now", () => {
    const now = new Date("2026-08-27T12:00:00Z");
    expect(cutoffFor(30, now).toISOString()).toBe("2026-08-27T11:30:00.000Z");
    expect(cutoffFor(0, now).toISOString()).toBe(now.toISOString());
  });
});

describe("statusesAgree", () => {
  it("agrees on CONFIRMED / BOOKED for a confirmed booking", () => {
    expect(statusesAgree("confirmed", "CONFIRMED")).toBe(true);
    expect(statusesAgree("confirmed", "confirmed")).toBe(true);
    expect(statusesAgree("confirmed", "BOOKED")).toBe(true);
  });

  it("disagrees when the supplier reports anything else for a confirmed booking", () => {
    expect(statusesAgree("confirmed", "CANCELLED")).toBe(false);
    expect(statusesAgree("confirmed", null)).toBe(false);
    expect(statusesAgree("confirmed", undefined)).toBe(false);
  });

  it("agrees on any CANCELLED* status for a cancelled booking", () => {
    expect(statusesAgree("cancelled", "CANCELLED")).toBe(true);
    expect(statusesAgree("cancelled", "CANCELLED_WITH_CHARGES")).toBe(true);
  });

  it("disagrees when the supplier still shows the booking live", () => {
    expect(statusesAgree("cancelled", "CONFIRMED")).toBe(false);
    expect(statusesAgree("cancelled", null)).toBe(false);
  });
});
