// Pure parsing over a LiteAPI webhook delivery. No db, no fetch — importable
// standalone (docs/conventions.md §1: a rule that needs a database to import
// is in the wrong file).
//
// The envelope (verified against using-liteapi-webhooks.md): `event_id` is
// the dedup key, `event_name` is the type (booking.book / booking.cancel /
// booking.refund / booking.amendment / booking.book.hotelConfirmationNumber /
// *_error), and `request` + `response` are BOTH-JSON-STRINGIFIED — "parse
// twice" is the docs' own phrasing. Per-event field names inside those two
// blobs are not published, so extraction below is deliberately tolerant
// (several candidate keys, several casings) rather than trusting one path —
// the same posture liteapi.ts already takes toward this supplier's inconsistent
// field naming (`(d as any).data ?? d`).

export type WebhookEnvelope = {
  eventId: string | null;
  eventName: string | null;
  request: Record<string, unknown> | null;
  response: Record<string, unknown> | null;
  sandbox: boolean | null;
};

function parseJsonMaybe(v: unknown): Record<string, unknown> | null {
  if (v == null) return null;
  if (typeof v === "object") return v as Record<string, unknown>;
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

export function parseWebhookEnvelope(body: unknown): WebhookEnvelope {
  const b = (body ?? {}) as Record<string, unknown>;
  return {
    eventId: str(b.event_id) ?? str(b.eventId),
    eventName: str(b.event_name) ?? str(b.eventName),
    request: parseJsonMaybe(b.request),
    response: parseJsonMaybe(b.response),
    sandbox: typeof b.sandbox === "boolean" ? b.sandbox : null,
  };
}

function deep(obj: Record<string, unknown> | null | undefined, ...keys: string[]): unknown {
  if (!obj) return undefined;
  for (const k of keys) if (obj[k] != null) return obj[k];
  const data = obj.data;
  if (data && typeof data === "object") {
    for (const k of keys) {
      const v = (data as Record<string, unknown>)[k];
      if (v != null) return v;
    }
  }
  return undefined;
}

/** LiteAPI's own booking id, wherever it shows up in response or request. */
export function extractLiteapiBookingId(env: WebhookEnvelope): string | null {
  const v = deep(env.response, "bookingId", "booking_id") ?? deep(env.request, "bookingId", "booking_id");
  if (typeof v === "string" && v) return v;
  if (typeof v === "number") return String(v);
  return null;
}

/** Refund amount in MINOR units (LiteAPI states money in major units). */
export function extractRefundAmountMinor(env: WebhookEnvelope): number | null {
  const v = deep(env.response, "refund_amount", "refundAmount");
  return typeof v === "number" ? Math.round(v * 100) : null;
}

export function extractSupplierStatus(env: WebhookEnvelope): string | null {
  const v = deep(env.response, "status");
  return typeof v === "string" ? v : null;
}
