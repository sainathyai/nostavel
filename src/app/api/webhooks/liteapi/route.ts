// Inbound LiteAPI webhook receiver. docs/production-readiness.md §2.3 calls
// this "the single highest-value missing piece" — without it, a hotel or
// wholesaler cancelling a booking on their end is invisible to us until
// someone checks LiteAPI's dashboard by hand.
//
// Auth is a shared secret in the `authorization` header (no signature scheme
// is documented). Delivery is at-least-once with exponential backoff, so this
// handler must (a) store the event durably BEFORE returning 200 — a 200
// returned before the write would let a crash between write and response look
// like success to LiteAPI and be silently lost — and (b) be a no-op on a
// redelivered `event_id`, which `webhook_events.external_id`'s unique
// constraint enforces at the database level, not just in application logic.
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { webhookEvents } from "@/db/schema";
import { verifySharedSecret } from "@/lib/webhook-auth";
import {
  parseWebhookEnvelope,
  extractLiteapiBookingId,
  extractRefundAmountMinor,
  extractSupplierStatus,
  type WebhookEnvelope,
} from "@/lib/webhook-format";
import { recordSupplierCancellation } from "@/lib/booking-service";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const auth = request.headers.get("authorization");
  if (!verifySharedSecret(auth, process.env.LITEAPI_WEBHOOK_SECRET)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad payload" }, { status: 400 });
  }

  const env = parseWebhookEnvelope(body);

  if (!env.eventId) {
    // No id to dedupe on. Store as evidence anyway; should be rare-to-never in
    // practice per the documented envelope.
    await db.insert(webhookEvents).values({ type: env.eventName, payload: body as object });
    return Response.json({ ok: true });
  }

  const inserted = await db
    .insert(webhookEvents)
    .values({ externalId: env.eventId, type: env.eventName, payload: body as object })
    .onConflictDoNothing({ target: webhookEvents.externalId })
    .returning({ id: webhookEvents.id });

  if (inserted.length === 0) {
    // Redelivery of an event already on file — ack without reprocessing.
    return Response.json({ ok: true, duplicate: true });
  }

  const rowId = inserted[0].id;
  try {
    await dispatch(env);
    await db.update(webhookEvents).set({ processedAt: new Date() }).where(eq(webhookEvents.id, rowId));
  } catch (e) {
    // The event is already durably stored, so a dispatch failure must not
    // become a 500 — that would make LiteAPI retry a delivery we already
    // have. processedAt stays null; the nightly reconciler is the safety net
    // for anything that fails to apply here.
    console.error("webhook dispatch failed", env.eventName, e);
  }

  return Response.json({ ok: true });
}

async function dispatch(env: WebhookEnvelope) {
  const name = env.eventName ?? "";
  if (name === "booking.cancel" || name === "booking.refund") {
    const liteapiBookingId = extractLiteapiBookingId(env);
    if (!liteapiBookingId) return;
    await recordSupplierCancellation(liteapiBookingId, {
      refundAmountMinor: extractRefundAmountMinor(env),
      status: extractSupplierStatus(env),
      raw: env.response ?? env.request ?? {},
    });
    return;
  }
  // booking.book / .amendment / .hotelConfirmationNumber / *_error: the stored
  // webhook_events row IS the record for these today (corroboration, not the
  // primary path — we already set our own status at checkout time). No
  // further write needed.
}
