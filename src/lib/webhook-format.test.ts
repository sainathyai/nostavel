import { describe, it, expect } from "vitest";
import {
  parseWebhookEnvelope,
  extractLiteapiBookingId,
  extractRefundAmountMinor,
  extractSupplierStatus,
} from "./webhook-format";

describe("parseWebhookEnvelope", () => {
  it("parses the documented envelope, unpacking stringified request/response", () => {
    const body = {
      event_id: "evt_123",
      event_name: "booking.cancel",
      request: JSON.stringify({ bookingId: "BK1" }),
      response: JSON.stringify({ bookingId: "BK1", status: "CANCELLED", refund_amount: 120.5 }),
      sandbox: true,
    };
    const env = parseWebhookEnvelope(body);
    expect(env.eventId).toBe("evt_123");
    expect(env.eventName).toBe("booking.cancel");
    expect(env.request).toEqual({ bookingId: "BK1" });
    expect(env.response).toEqual({ bookingId: "BK1", status: "CANCELLED", refund_amount: 120.5 });
    expect(env.sandbox).toBe(true);
  });

  it("tolerates camelCase envelope keys", () => {
    const env = parseWebhookEnvelope({ eventId: "evt_9", eventName: "booking.book" });
    expect(env.eventId).toBe("evt_9");
    expect(env.eventName).toBe("booking.book");
  });

  it("tolerates request/response already being objects, not strings", () => {
    const env = parseWebhookEnvelope({
      event_id: "e1",
      event_name: "booking.book",
      request: { a: 1 },
      response: { b: 2 },
    });
    expect(env.request).toEqual({ a: 1 });
    expect(env.response).toEqual({ b: 2 });
  });

  it("returns nulls rather than throwing on malformed JSON strings", () => {
    const env = parseWebhookEnvelope({ event_id: "e1", request: "{not json", response: "also not json" });
    expect(env.request).toBeNull();
    expect(env.response).toBeNull();
  });

  it("returns an all-null envelope for garbage input", () => {
    expect(parseWebhookEnvelope(null)).toEqual({
      eventId: null,
      eventName: null,
      request: null,
      response: null,
      sandbox: null,
    });
    expect(parseWebhookEnvelope("not an object")).toEqual({
      eventId: null,
      eventName: null,
      request: null,
      response: null,
      sandbox: null,
    });
  });
});

describe("extractLiteapiBookingId", () => {
  it("reads bookingId from the response first", () => {
    const env = parseWebhookEnvelope({
      response: JSON.stringify({ bookingId: "BK-response" }),
      request: JSON.stringify({ bookingId: "BK-request" }),
    });
    expect(extractLiteapiBookingId(env)).toBe("BK-response");
  });

  it("falls back to the request when the response has none", () => {
    const env = parseWebhookEnvelope({ request: JSON.stringify({ bookingId: "BK-request" }) });
    expect(extractLiteapiBookingId(env)).toBe("BK-request");
  });

  it("tolerates snake_case and a nested data wrapper", () => {
    expect(extractLiteapiBookingId(parseWebhookEnvelope({ response: JSON.stringify({ booking_id: "BK1" }) }))).toBe(
      "BK1",
    );
    expect(
      extractLiteapiBookingId(parseWebhookEnvelope({ response: JSON.stringify({ data: { bookingId: "BK2" } }) })),
    ).toBe("BK2");
  });

  it("coerces a numeric id to a string", () => {
    expect(extractLiteapiBookingId(parseWebhookEnvelope({ response: JSON.stringify({ bookingId: 4242 }) }))).toBe(
      "4242",
    );
  });

  it("returns null when no id is found anywhere", () => {
    expect(extractLiteapiBookingId(parseWebhookEnvelope({}))).toBeNull();
  });
});

describe("extractRefundAmountMinor", () => {
  it("converts a major-unit refund_amount to minor units", () => {
    const env = parseWebhookEnvelope({ response: JSON.stringify({ refund_amount: 120.5 }) });
    expect(extractRefundAmountMinor(env)).toBe(12050);
  });

  it("returns null when absent", () => {
    expect(extractRefundAmountMinor(parseWebhookEnvelope({}))).toBeNull();
  });
});

describe("extractSupplierStatus", () => {
  it("reads status from the response", () => {
    const env = parseWebhookEnvelope({ response: JSON.stringify({ status: "CANCELLED_WITH_CHARGES" }) });
    expect(extractSupplierStatus(env)).toBe("CANCELLED_WITH_CHARGES");
  });

  it("returns null when absent", () => {
    expect(extractSupplierStatus(parseWebhookEnvelope({}))).toBeNull();
  });
});
