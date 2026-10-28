// Integration test: proves (or disproves) LiteAPI webhook redelivery dedupe
// against a REAL Postgres unique constraint (webhookEvents.externalId), not
// a mock — `insert().onConflictDoNothing()`'s atomicity is a property of
// Postgres itself, and the whole point of NOS-33's suite is to exercise real
// concurrency/constraint behaviour rather than simulate it (see the NOS-6
// and NOS-5 tests in this suite for the same reasoning applied to their own
// compare-and-swap idioms).
//
// WHAT THIS PROVES: LiteAPI delivers webhooks at-least-once with backoff
// (route.ts's own file comment), so a redelivered `event_id` must be
// acknowledged without a second dispatch. If it dispatched twice, a
// redelivered `booking.refund` would insert a SECOND `cancellations` row
// carrying the same refund amount again — money-losing in the sense that
// anything reconciling that table against LiteAPI's actual payout would
// double-count a refund that only happened once.
//
// UNLIKE NOS-5 and NOS-6, this is NOT a live bug: the route's
// `onConflictDoNothing({ target: webhookEvents.externalId })` relies on
// Postgres's own unique-constraint enforcement, which — unlike
// confirmBooking's bare `UPDATE ... WHERE id = ...` (NOS-6) — IS atomic
// under concurrent writers, and this test only exercises sequential
// redelivery (the documented LiteAPI behaviour) besides.
//
// This test shipped as `it.fails` because, until the harness could actually
// be run (the suite never reached a migrated database — see
// scripts/test-int-migrate.mjs, NOS-29 defect 2), nobody could say whether
// the dedupe held in practice. The first real run proved it does: the
// assertions below pass against a real Postgres. Per the ticket, an
// `it.fails` that starts passing is a decision for the tech lead rather
// than something to resolve by bending the assertions — the owner took that
// decision, and it is now a plain `it`: a standing regression guard that
// fails if webhook dedupe ever regresses, which is what it was always for.
// NOS-5 and NOS-6 below keep their `it.fails` markers; those bugs are real
// and still open.
//
// (`recordSupplierCancellation`, what `dispatch()` calls for booking.cancel
// / booking.refund, also has its OWN idempotency guard — "already
// cancelled" — which would independently prevent a second `cancellations`
// row even if the webhook-layer dedupe below were broken. That is a
// separate, deeper safety net; the assertions below on `duplicate: true`
// and the single stored `webhookEvents` row are what isolate the CLAIM
// under test — that a redelivery never reaches `dispatch()` a second time
// at all — from that deeper guard.)
import { describe, it, expect, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { bookings, cancellations, webhookEvents } from "@/db/schema";
import { POST as receiveWebhook } from "./route";
import { seedPrebookedBooking, fakeSharedSecret } from "@/test-support/db-fixtures";
import { buildFakeWebhookPayload } from "@/test-support/fake-liteapi";

let deliveryCount = 0;

describe("redelivering the same LiteAPI webhook event_id (standing regression guard)", () => {
  it("does not dispatch a redelivered event a second time", async () => {
    const webhookSecret = fakeSharedSecret("liteapi-webhook");
    process.env.LITEAPI_WEBHOOK_SECRET = webhookSecret;

    const liteapiBookingId = "fake-supplier-booking-" + Date.now();
    const seeded = await seedPrebookedBooking({
      status: "confirmed",
      liteapiBookingId,
    });

    const eventId = "evt-redelivery-" + Date.now();
    const payload = buildFakeWebhookPayload({
      eventId,
      eventName: "booking.refund",
      bookingId: liteapiBookingId,
      status: "CANCELLED_WITH_CHARGES",
    });

    // Auth is a shared secret IN the authorization header, verbatim — no
    // "Bearer " prefix (see webhook-auth.ts / route.ts's own comment: "no
    // signature scheme is documented... the header value IS the whole
    // control").
    const send = () =>
      receiveWebhook(
        new Request("http://localhost/api/webhooks/liteapi", {
          method: "POST",
        // A distinct address per delivery (NOS-13). The route is rate-limited
        // per client address now, and every delivery in this file would
        // otherwise share one bucket keyed "local": harmless at today's count,
        // a confusing 429 the moment this file grows past the window's limit.
          headers: {
            authorization: webhookSecret,
            "content-type": "application/json",
            "x-forwarded-for": `198.51.100.${(deliveryCount += 1) % 250}`,
          },
          body: JSON.stringify(payload),
        }),
      );

    const first = await send();
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { ok: boolean; duplicate?: boolean };
    expect(firstBody.duplicate).toBeUndefined();

    // Sequential, matching LiteAPI's documented at-least-once-with-backoff
    // redelivery — a genuine second HTTP delivery of the same event, not a
    // simulated retry.
    const second = await send();
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { ok: boolean; duplicate?: boolean };
    // The direct claim under test: the route recognizes this as a
    // redelivery and acks it without reprocessing.
    expect(secondBody.duplicate).toBe(true);

    const storedEvents = await db.select().from(webhookEvents).where(eq(webhookEvents.externalId, eventId));
    expect(storedEvents.length).toBe(1);

    // The money-losing direction, confirmed at the ledger: only one
    // cancellations row for the one refund LiteAPI actually issued.
    const cancellationRows = await db
      .select()
      .from(cancellations)
      .where(eq(cancellations.bookingId, seeded.id));
    expect(cancellationRows.length).toBe(1);

    const [row] = await db.select().from(bookings).where(eq(bookings.id, seeded.id));
    expect(row.status).toBe("cancelled");
  });
});

describe("a delivery with no event_id (NOS-14, threat-model gap G3)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The documented envelope always carries `event_id`; this is the case where it does not. */
  function withoutEventId(payload: Record<string, unknown>): Record<string, unknown> {
    const copy = { ...payload };
    delete copy.event_id;
    return copy;
  }

  async function deliverNoId(payload: Record<string, unknown>, secret: string): Promise<Response> {
    return receiveWebhook(
      new Request("http://localhost/api/webhooks/liteapi", {
        method: "POST",
        headers: { authorization: secret, "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
    );
  }

  it("warns that a cancellation was NOT applied, while still storing the row", async () => {
    // THE DEFECT, DIRECTLY. This branch cannot deduplicate, so it stores and
    // does not dispatch - and it was silent. A supplier cancellation arriving
    // here left the booking `confirmed` with the evidence sitting in
    // `webhook_events` and nobody with a reason to go and look.
    const webhookSecret = fakeSharedSecret("liteapi-webhook");
    process.env.LITEAPI_WEBHOOK_SECRET = webhookSecret;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const liteapiBookingId = "fake-supplier-noid-" + Date.now();
    const seeded = await seedPrebookedBooking({ status: "confirmed", liteapiBookingId });

    const response = await deliverNoId(
      withoutEventId(
        buildFakeWebhookPayload({
          eventId: "unused-this-is-deleted",
          eventName: "booking.cancel",
          bookingId: liteapiBookingId,
          status: "CANCELLED",
        }),
      ),
      webhookSecret,
    );

    // Unchanged behaviour: accepted, stored, not dispatched (AC 4).
    expect(response.status).toBe(200);

    const [booking] = await db.select().from(bookings).where(eq(bookings.id, seeded.id)).limit(1);
    expect(booking.status).toBe("confirmed");
    const cancelRows = await db
      .select()
      .from(cancellations)
      .where(eq(cancellations.bookingId, seeded.id));
    expect(cancelRows).toHaveLength(0);

    // The row is on file as evidence, with no external id to dedupe on.
    const stored = await db.select().from(webhookEvents).where(eq(webhookEvents.type, "booking.cancel"));
    expect(stored.some((row) => row.externalId === null)).toBe(true);

    // And the part this ticket adds: somebody can now find out. Since NOS-69 the
    // line is JSON, so this also proves the structured shape survives the whole
    // route rather than only a unit test of the logger.
    expect(warn).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(String(warn.mock.calls[0][0])) as Record<string, unknown>;
    expect(entry).toMatchObject({
      severity: "WARNING",
      event: "webhook.missing_event_id",
      eventName: "booking.cancel",
    });
    expect(String(entry.message)).toContain("NOT APPLIED");
    expect(String(entry.message)).toContain("no event_id");
  });

  it("says nothing on the normal path, so the warning stays worth reading", async () => {
    // AC 2. A warning that fires on every delivery is noise, and noise is what
    // stops the severe case above being noticed.
    const webhookSecret = fakeSharedSecret("liteapi-webhook");
    process.env.LITEAPI_WEBHOOK_SECRET = webhookSecret;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const liteapiBookingId = "fake-supplier-withid-" + Date.now();
    await seedPrebookedBooking({ status: "confirmed", liteapiBookingId });

    const response = await deliverNoId(
      buildFakeWebhookPayload({
        eventId: "evt-has-an-id-" + Date.now(),
        eventName: "booking.cancel",
        bookingId: liteapiBookingId,
        status: "CANCELLED",
      }),
      webhookSecret,
    );

    expect(response.status).toBe(200);
    expect(warn).not.toHaveBeenCalled();
  });
});
