// The supplier's error, with its code intact.
//
// WHY THIS EXISTS. `api()` used to throw `new Error("LiteAPI 400: " +
// error.message)`, which discards everything but the prose. For the one response
// the booking recovery path depends on, the prose is the least useful field:
//
//   { "error": { "code": 2014,
//                "description": "payment not completed",
//                "message": "booking incomplete" } }
//
// `message` is "booking incomplete". The fact that the guest has not paid lives
// in `code` and `description`, and both were thrown away. So a detector written
// against the thrown text could not match the only response it was built for -
// found by the security review of NOS-5, after the evidence had been sitting in
// this repository's own probe output (analysis/2026-10-06/raw) the whole time.
//
// Separate module, not inside liteapi.ts, so the test double can construct the
// same error without importing the module it stands in for.
export class LiteApiError extends Error {
  readonly status: number;
  /** The supplier's own error code, e.g. 2014. Null when it sends none. */
  readonly code: number | null;
  /** The supplier's `description`, which is usually the specific part. */
  readonly description: string | null;

  constructor(status: number, body: unknown) {
    const error = (body as { error?: Record<string, unknown> } | null)?.error;
    const message = typeof error?.message === "string" ? error.message : null;
    const description = typeof error?.description === "string" ? error.description : null;
    const code = typeof error?.code === "number" ? error.code : null;

    // The thrown text keeps the shape it has always had, so logs and the one
    // guest-facing relay of it do not change. What is new is everything
    // alongside it.
    super(`LiteAPI ${status}: ${message ?? description ?? JSON.stringify(body)}`);
    this.name = "LiteApiError";
    this.status = status;
    this.code = code;
    this.description = description;
  }
}

/** The supplier's code for "this transaction has not been paid for". */
export const LITEAPI_PAYMENT_NOT_COMPLETED = 2014;
