import { beforeAll, describe, expect, it } from "vitest";

import {
  ACCESS_TTL_SEC,
  addBookingAccess,
  readBookingAccess,
  signBookingAccess,
} from "./booking-access";
import { sealClaim } from "./signed-claim";

beforeAll(() => {
  process.env.AUTH_SECRET = "test-secret-do-not-use-anywhere-real";
});

const T0 = Date.UTC(2026, 9, 5, 12, 0, 0);
const SEC = 1000;
const A = "bkg_aaaa";
const B = "bkg_bbbb";

describe("the access claim", () => {
  it("round-trips the ids it was given", () => {
    expect(readBookingAccess(signBookingAccess([A, B], T0), T0)).toEqual([
      A,
      B,
    ]);
  });

  it("survives right up to expiry and not past it", () => {
    const token = signBookingAccess([A], T0);
    expect(readBookingAccess(token, T0 + (ACCESS_TTL_SEC - 1) * SEC)).toEqual([
      A,
    ]);
    expect(readBookingAccess(token, T0 + ACCESS_TTL_SEC * SEC)).toEqual([]);
  });

  it("reads a missing or malformed claim as no proof rather than throwing", () => {
    for (const bad of [
      null,
      undefined,
      "",
      "not-a-token",
      ".",
      "a.",
      ".b",
      "a.b.c",
    ]) {
      expect(readBookingAccess(bad, T0)).toEqual([]);
    }
  });

  it("refuses a tampered payload", () => {
    const token = signBookingAccess([A], T0);
    const forged = Buffer.from(JSON.stringify({ d: [B], e: 9e9 })).toString(
      "base64url",
    );
    expect(
      readBookingAccess(`${forged}.${token.slice(token.indexOf(".") + 1)}`, T0),
    ).toEqual([]);
  });

  it("refuses a claim signed with a different secret", () => {
    const token = signBookingAccess([A], T0);
    process.env.AUTH_SECRET = "a-different-secret-entirely";
    try {
      expect(readBookingAccess(token, T0)).toEqual([]);
    } finally {
      process.env.AUTH_SECRET = "test-secret-do-not-use-anywhere-real";
    }
  });

  it("ignores a correctly signed claim whose payload is the wrong shape", () => {
    // A signature proves we wrote the token, not that this version of the code
    // wrote the fields it expects.
    for (const shape of [{ id: A }, "just-a-string", 42, [1, 2, 3], null]) {
      expect(readBookingAccess(sealClaim(shape, 600, T0), T0)).toEqual([]);
    }
  });

  it("drops empty and non-string ids rather than carrying them", () => {
    expect(
      readBookingAccess(sealClaim([A, "", 7, null, B], 600, T0), T0),
    ).toEqual([A, B]);
  });

  it("stays small enough to send on every request", () => {
    expect(signBookingAccess([A, B], T0).length).toBeLessThan(300);
  });
});

describe("adding a booking to an existing claim", () => {
  it("keeps the earlier booking's proof", () => {
    const first = signBookingAccess([A], T0);
    const second = addBookingAccess(first, B, T0 + 60 * SEC);
    expect(readBookingAccess(second, T0 + 60 * SEC)).toEqual([A, B]);
  });

  it("starts a fresh claim when the browser holds none", () => {
    expect(readBookingAccess(addBookingAccess(null, A, T0), T0)).toEqual([A]);
  });

  it("does not list the same booking twice when a prepare is retried", () => {
    const once = addBookingAccess(null, A, T0);
    expect(readBookingAccess(addBookingAccess(once, A, T0), T0)).toEqual([A]);
  });

  it("re-extends the expiry over the whole list, so an earlier booking is not orphaned mid-checkout", () => {
    const first = signBookingAccess([A], T0);
    const late = T0 + (ACCESS_TTL_SEC - 10) * SEC;
    const second = addBookingAccess(first, B, late);
    // A would have expired by now under its own clock.
    expect(readBookingAccess(second, late + 60 * SEC)).toEqual([A, B]);
  });

  it("drops an expired claim rather than carrying its ids forward", () => {
    // Re-sealing must not resurrect proof the guest no longer holds.
    const stale = signBookingAccess([A], T0);
    const later = T0 + (ACCESS_TTL_SEC + 1) * SEC;
    expect(readBookingAccess(addBookingAccess(stale, B, later), later)).toEqual(
      [B],
    );
  });

  it("keeps the ten most recent bookings and forgets the oldest", () => {
    let token = signBookingAccess([], T0);
    for (let i = 0; i < 12; i++)
      token = addBookingAccess(token, `bkg_${i}`, T0);
    const ids = readBookingAccess(token, T0);
    expect(ids).toHaveLength(10);
    expect(ids[0]).toBe("bkg_2");
    expect(ids.at(-1)).toBe("bkg_11");
  });
});
