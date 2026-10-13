// Integration test: the nightly reconciler against a REAL Postgres
// (vitest.integration.config.ts).
//
// THE FIRST TESTS THIS ROUTE HAS EVER HAD. It is one of the two money-safety jobs
// and it shipped with none, which is part of how NOS-64 survived: the defect was a
// `WHERE` clause, and nothing exercised the query against real rows. The other
// part is mechanical - the fake supplier had no `getSupplierBooking`, so any test
// that mocked `@/lib/liteapi` left the route calling undefined. That export was
// added with this file.
//
// WHAT THIS FILE PROMISES: the reconciler's silence means "I compared these
// bookings and they agree", not "I could not see them". Every assertion below is
// about which rows it can see, because that is the half that was wrong.
import { beforeEach, describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { bookingEvents, bookings } from "@/db/schema";
import { POST as reconcile } from "./route";
import {
  seedPrebookedBooking,
  fakeSharedSecret,
  resetTestDatabase,
} from "@/test-support/db-fixtures";
import {
  configureSupplierBooking,
  configureSupplierBookingError,
  resetFakeSupplier,
} from "@/test-support/fake-liteapi";

// No test reaches LiteAPI over the network (NOS-29 AC 6).
vi.mock("@/lib/liteapi", async () => import("@/test-support/fake-liteapi"));

type Summary = {
  ok: boolean;
  checked: number;
  mismatches: number;
  missingSupplierCost: number;
  errors: { bookingId: string; error: string }[];
};

async function runReconcile(): Promise<Summary> {
  const cronSecret = fakeSharedSecret("cron");
  process.env.CRON_SECRET = cronSecret;
  const response = await reconcile(
    new Request("http://localhost/api/cron/reconcile", {
      method: "POST",
      headers: { authorization: `Bearer ${cronSecret}` },
    }),
  );
  expect(response.status).toBe(200);
  return response.json();
}

async function eventTypes(id: string): Promise<string[]> {
  const rows = await db.select().from(bookingEvents).where(eq(bookingEvents.bookingId, id));
  return rows.map((r) => r.type);
}

/**
 * A booking in the state the reconciler looks at: finalized, with a supplier id
 * to compare against. `amountSupplierMinor` is left to the caller, because it is
 * the column this ticket is about.
 */
async function seedFinalized(overrides: {
  humanRef?: string;
  status?: string;
  amountSupplierMinor?: number | null;
  liteapiBookingId?: string | null;
}) {
  return seedPrebookedBooking({
    status: (overrides.status ?? "confirmed") as never,
    humanRef: overrides.humanRef ?? "NSTVL-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
    liteapiBookingId:
      overrides.liteapiBookingId === undefined
        ? "supplier-" + Math.random().toString(36).slice(2, 8)
        : overrides.liteapiBookingId,
    amountSupplierMinor:
      overrides.amountSupplierMinor === undefined ? 10_000 : overrides.amountSupplierMinor,
  });
}

// Unlike the sweeper's suite, which asserts about named rows, every assertion
// here is about a WHOLE RUN's counts: which bookings the reconciler could see is
// the thing under test. So rows must not survive between tests, or one test's
// fixtures become another's "checked" total.
beforeEach(async () => {
  await resetTestDatabase();
  resetFakeSupplier();
});

describe("which bookings the reconciler can see (NOS-64)", () => {
  it("sees a current-era confirmed booking with no recorded supplier cost", async () => {
    // THE DEFECT, DIRECTLY. The old predicate was
    // `isNotNull(amountSupplierMinor)`, so this row was excluded from every pass
    // forever - and a confirmed booking with no record of what the supplier
    // charged us is the row most worth looking at, not the least.
    const booking = await seedFinalized({ amountSupplierMinor: null });

    const summary = await runReconcile();

    expect(summary.missingSupplierCost).toBe(1);
    expect(await eventTypes(booking.id)).toContain("reconcile.missing_supplier_cost");
  });

  it("still compares that booking's status against the supplier, rather than only flagging it", async () => {
    // The missing cost must not become a reason to skip the comparison: the row
    // is finalized, so whether the supplier agrees is still a separate question.
    const booking = await seedFinalized({ amountSupplierMinor: null });
    configureSupplierBooking(booking.liteapiBookingId!, { status: "CANCELLED" });

    const summary = await runReconcile();

    expect(summary.checked).toBe(1);
    expect(summary.mismatches).toBe(1);
    const types = await eventTypes(booking.id);
    expect(types).toContain("reconcile.missing_supplier_cost");
    expect(types).toContain("reconcile.mismatch");
  });

  it("reports a missing supplier cost even when the supplier cannot be reached", async () => {
    // The ledger is incomplete regardless of what the supplier says, so this
    // finding must not depend on a network call succeeding.
    const booking = await seedFinalized({ amountSupplierMinor: null });
    configureSupplierBookingError(new Error("supplier down"));

    const summary = await runReconcile();

    expect(summary.missingSupplierCost).toBe(1);
    expect(summary.errors).toHaveLength(1);
    expect(await eventTypes(booking.id)).toContain("reconcile.missing_supplier_cost");
  });

  it("writes the missing-cost event once, not once per nightly run", async () => {
    // A permanent condition on a nightly job would otherwise collect one
    // identical event every night forever, and an alert nobody can read is an
    // alert nobody reads.
    const booking = await seedFinalized({ amountSupplierMinor: null });

    await runReconcile();
    await runReconcile();

    const types = await eventTypes(booking.id);
    expect(types.filter((t) => t === "reconcile.missing_supplier_cost")).toHaveLength(1);
  });
});

describe("the exclusions that §1.2 settled, which must still hold", () => {
  it("still excludes the LNTRN legacy era", async () => {
    // §1.2: 16 rows written 2026-08-03 to 08-05, before supplier net was recorded
    // at all. Comparing them would produce false mismatches forever. They are now
    // excluded by what makes them legacy - the era prefix - rather than by the
    // null column, which was catching every later row too.
    const booking = await seedFinalized({
      humanRef: "LNTRN-795BNM",
      amountSupplierMinor: null,
    });

    const summary = await runReconcile();

    expect(summary.checked).toBe(0);
    expect(summary.missingSupplierCost).toBe(0);
    expect(await eventTypes(booking.id)).toHaveLength(0);
  });

  it("still excludes the FIX prebook fixtures", async () => {
    const booking = await seedFinalized({ humanRef: "FIX0001", amountSupplierMinor: null });

    const summary = await runReconcile();

    expect(summary.checked).toBe(0);
    expect(await eventTypes(booking.id)).toHaveLength(0);
  });

  it("does not treat a legacy-looking reference elsewhere in the string as legacy", async () => {
    // The exclusion is a prefix, not a substring: a current-era reference that
    // merely contains the letters must still be reconciled.
    const booking = await seedFinalized({
      humanRef: "NSTVL-LNTRN1",
      amountSupplierMinor: null,
    });

    const summary = await runReconcile();

    expect(summary.missingSupplierCost).toBe(1);
    expect(await eventTypes(booking.id)).toContain("reconcile.missing_supplier_cost");
  });
});

describe("the behaviour that was already correct and must stay so", () => {
  it("records no mismatch when our status and the supplier's agree", async () => {
    const booking = await seedFinalized({ amountSupplierMinor: 10_000 });
    configureSupplierBooking(booking.liteapiBookingId!, { status: "CONFIRMED" });

    const summary = await runReconcile();

    expect(summary.checked).toBe(1);
    expect(summary.mismatches).toBe(0);
    expect(summary.missingSupplierCost).toBe(0);
    expect(await eventTypes(booking.id)).toHaveLength(0);
  });

  it("records a mismatch when they disagree, and never rewrites our status", async () => {
    // conventions §8: the ledger is evidence. This job writes a finding and
    // leaves the row alone.
    const booking = await seedFinalized({ amountSupplierMinor: 10_000 });
    configureSupplierBooking(booking.liteapiBookingId!, { status: "CANCELLED" });

    const summary = await runReconcile();

    expect(summary.mismatches).toBe(1);
    const [row] = await db.select().from(bookings).where(eq(bookings.id, booking.id)).limit(1);
    expect(row.status).toBe("confirmed");
  });

  it("skips a row with no supplier booking id rather than calling the supplier", async () => {
    const booking = await seedFinalized({
      liteapiBookingId: null,
      amountSupplierMinor: 10_000,
    });

    const summary = await runReconcile();

    expect(summary.checked).toBe(0);
    expect(await eventTypes(booking.id)).toHaveLength(0);
  });

  it("refuses a request with no shared secret", async () => {
    process.env.CRON_SECRET = fakeSharedSecret("cron");
    const response = await reconcile(
      new Request("http://localhost/api/cron/reconcile", { method: "POST" }),
    );
    expect(response.status).toBe(401);
  });
});
