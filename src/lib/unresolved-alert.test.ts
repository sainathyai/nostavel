// The one alert about a guest's money, as a person will read it (NOS-56).
//
// This line is not written for a log viewer: the Terraform policy attaches the
// entry to an email, so the message has to stand on its own in an inbox at an
// hour when nobody is going to open a query first. That is what these assert.
import { describe, it, expect, vi } from "vitest";
import { alertUnresolvedPayment, unresolvedPaymentLine, type UnresolvedPayment } from "./unresolved-alert";

const UNRESOLVED: UnresolvedPayment = {
  bookingId: "11111111-2222-3333-4444-555555555555",
  humanRef: "LNTRN-7QK2",
  currency: "USD",
  amountTotalMinor: 41255,
  transactionId: "txn_abc123",
  prebookId: "pre_xyz789",
  reason: "the hold lapsed while a payment was in flight",
};

function emitted(u: UnresolvedPayment): Record<string, unknown> {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    alertUnresolvedPayment(u);
    return JSON.parse(String(spy.mock.calls[0][0])) as Record<string, unknown>;
  } finally {
    spy.mockRestore();
  }
}

describe("the sentence that arrives in an inbox (AC 1, AC 3)", () => {
  it("says what happened, to which booking, for how much, and what was tried", () => {
    const { message } = unresolvedPaymentLine(UNRESOLVED);

    expect(message).toContain("A guest may have been charged with no booking.");
    expect(message).toContain("LNTRN-7QK2");
    expect(message).toContain("USD 412.55");
    expect(message).toContain("txn_abc123");
    expect(message).toContain("the hold lapsed while a payment was in flight");
  });

  it("ends by naming the runbook, because the next step is not obvious", () => {
    // AC 3 is a documentation criterion, and this is the only place the owner
    // is guaranteed to be looking when it matters.
    expect(unresolvedPaymentLine(UNRESOLVED).message).toContain("docs/runbooks/unresolved-payment.md");
  });

  it("names the amount in the currency's code, not a symbol", () => {
    // Whoever reads this is about to look at a supplier dashboard, which shows
    // the code. `email.ts` uses `$` because it is writing to a guest.
    const eur = unresolvedPaymentLine({ ...UNRESOLVED, currency: "EUR", amountTotalMinor: 9900 });
    expect(eur.message).toContain("EUR 99.00");
  });

  it("falls back to the prebook when there is no transaction, and says so when there is neither", () => {
    // A row that never reached the payment step has no transaction id, and the
    // prebook is then the only thing the supplier can look up.
    expect(unresolvedPaymentLine({ ...UNRESOLVED, transactionId: null }).message).toContain("pre_xyz789");
    expect(
      unresolvedPaymentLine({ ...UNRESOLVED, transactionId: null, prebookId: null }).message,
    ).toContain("supplier transaction none recorded");
  });
});

describe("the fields, which are what a query and a filter use", () => {
  it("carries the booking, the money and both supplier references", () => {
    expect(unresolvedPaymentLine(UNRESOLVED).fields).toEqual({
      bookingId: "11111111-2222-3333-4444-555555555555",
      humanRef: "LNTRN-7QK2",
      currency: "USD",
      amountTotalMinor: 41255,
      transactionId: "txn_abc123",
      prebookId: "pre_xyz789",
      reason: "the hold lapsed while a payment was in flight",
    });
  });

  it("is an ERROR line under the event the alert policy filters on", () => {
    // `infra/envs/uat/observability.tf` matches
    // `jsonPayload.event="payment.unresolved"`. log-contract.test.ts is what
    // stops that name drifting; this just pins what this module emits.
    const entry = emitted(UNRESOLVED);
    expect(entry.severity).toBe("ERROR");
    expect(entry.event).toBe("payment.unresolved");
    expect(entry.humanRef).toBe("LNTRN-7QK2");
  });

  it("keeps a guest's address out even when the reason quotes one", () => {
    // The type has no field for it, which is the real control. This covers the
    // other way one could arrive: a supplier message echoed into `reason`.
    const entry = emitted({ ...UNRESOLVED, reason: "supplier rejected guest@example.com" });
    expect(JSON.stringify(entry)).not.toContain("guest@example.com");
    expect(String(entry.reason)).toContain("[email redacted]");
  });
});
