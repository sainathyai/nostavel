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
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { bookings, cancellations, webhookEvents } from "@/db/schema";
import { POST as receiveWebhook } from "./route";
import { seedPrebookedBooking, fakeSharedSecret } from "@/test-support/db-fixtures";
import { buildFakeWebhookPayload } from "@/test-support/fake-liteapi";

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
          headers: { authorization: webhookSecret, "content-type": "application/json" },
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
