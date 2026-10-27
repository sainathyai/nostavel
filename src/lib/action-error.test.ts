// The guest-facing error contract (NOS-11). Pure apart from one injected log,
// so every branch is reachable without a database, a network or a console.
import { describe, it, expect, vi } from "vitest";
import {
  describeThrown,
  guestMessage,
  newReference,
  reportFailure,
  type FailureScope,
} from "./action-error";
import { LiteApiError } from "./liteapi-error";

const ALL_SCOPES = [
  "prepare",
  "guest",
  "payment",
  "confirm",
  "cancel",
  "search",
  "area-search",
  "hotel-extras",
] as const satisfies readonly FailureScope[];

// A STALE LIST IS WHY THIS GUARD EXISTS. The first version of this file listed
// six scopes and `FailureScope` grew to eight while widening the fix past the
// ticket's call sites. Every "for every scope" test below still passed, because
// it iterated the list rather than the type, and CI's coverage report was the
// only thing that noticed the two new messages were never executed.
//
// So the list is now checked against the union at COMPILE time: if a scope is
// added to `FailureScope` and not here, `Missing` stops being `never` and this
// assignment stops type-checking, which `tsc --noEmit` fails on in CI.
type Missing = Exclude<FailureScope, (typeof ALL_SCOPES)[number]>;
const everyScopeIsCovered: Missing extends never ? true : Missing = true;

/** The real shapes this used to leak, taken from the modules that throw them. */
const REAL_LEAKS = {
  // src/lib/liteapi.ts, via LiteApiError: the supplier's own words.
  supplier: new LiteApiError(400, {
    error: { code: 2014, description: "payment not completed", message: "booking incomplete" },
  }),
  // src/lib/booking-service.ts: our own status vocabulary.
  internalState: new Error("Booking is not open for guest details (status: payment_pending)"),
  // src/lib/liteapi.ts: an instruction meant for whoever runs the service.
  configuration: new Error("LITEAPI_KEY missing. Add it to .env.local"),
};

describe("the scope list this file iterates is the whole type", () => {
  it("covers every FailureScope", () => {
    // The compile-time guard above is the real check; this makes the intent
    // visible in the test output and keeps the constant referenced.
    expect(everyScopeIsCovered).toBe(true);
    expect(ALL_SCOPES.length).toBe(new Set(ALL_SCOPES).size);
  });
});

describe("nothing a guest is shown carries supplier or internal detail (NOS-11)", () => {
  it("replaces the supplier's own error text with fixed copy", () => {
    // THE DEFECT, DIRECTLY. `error: (e as Error).message` put this string in the
    // browser: "LiteAPI 400: booking incomplete".
    const lines: string[] = [];
    const { error } = reportFailure("confirm", REAL_LEAKS.supplier, {
      reference: "AAAA1111",
      log: (l) => lines.push(l),
    });

    expect(error).not.toMatch(/LiteAPI/i);
    expect(error).not.toMatch(/booking incomplete/i);
    expect(error).not.toMatch(/2014/);
    // And it is not lost: the log kept every part of it.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("LiteAPI 400: booking incomplete");
  });

  it("does not tell a stranger our status vocabulary", () => {
    const lines: string[] = [];
    const { error } = reportFailure("guest", REAL_LEAKS.internalState, {
      reference: "BBBB2222",
      log: (l) => lines.push(l),
    });
    expect(error).not.toMatch(/payment_pending/);
    expect(error).not.toMatch(/status/i);
    expect(lines[0]).toContain("payment_pending");
  });

  it("does not show a guest an instruction meant for an operator", () => {
    const lines: string[] = [];
    const { error } = reportFailure("prepare", REAL_LEAKS.configuration, {
      reference: "CCCC3333",
      log: (l) => lines.push(l),
    });
    expect(error).not.toMatch(/LITEAPI_KEY/);
    expect(error).not.toMatch(/env\.local/);
    expect(lines[0]).toContain("LITEAPI_KEY missing");
  });

  it("keeps no part of the thrown text in any scope's message", () => {
    // Every scope, one assertion: a new scope added later with careless copy
    // fails here rather than in production.
    for (const scope of ALL_SCOPES) {
      const { error } = reportFailure(scope, REAL_LEAKS.supplier, {
        reference: "DDDD4444",
        log: () => {},
      });
      expect(error, scope).not.toMatch(/LiteAPI|incomplete|2014|payment_pending/i);
      expect(error, scope).toContain("DDDD4444");
    }
  });
});

describe("the reference is the whole point: it must be in both places", () => {
  it("puts the same id in the guest's message and the log line", () => {
    // AC 6. A safe message with nothing to correlate is just a worse error
    // message: an operator hearing "it said something went wrong" has nothing
    // to search for.
    const lines: string[] = [];
    const report = reportFailure("prepare", new Error("upstream exploded"), {
      log: (l) => lines.push(l),
    });

    expect(report.error).toContain(report.reference);
    expect(lines[0]).toContain(report.reference);
    expect(lines[0]).toContain("upstream exploded");
  });

  it("names the scope as a FIELD, so the search is a filter and not a substring", () => {
    // Was `[action:cancel]` in free text. Since NOS-69 the line is JSON, so
    // `jsonPayload.scope="cancel"` is a filter a metric could be built on, and
    // the scope is still in the sentence a human reads.
    const lines: string[] = [];
    reportFailure("cancel", new Error("boom"), { reference: "EEEE5555", log: (l) => lines.push(l) });

    const entry = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(entry).toMatchObject({ severity: "ERROR", event: "action.failed", scope: "cancel", reference: "EEEE5555" });
    expect(String(entry.message)).toContain("cancel failed");
  });

  it("logs one line, not several arguments", () => {
    // `console.error("a", "b")` is two fields in Cloud Logging and `grep` finds
    // neither reliably. The contract is one string.
    const calls: unknown[][] = [];
    reportFailure("confirm", new Error("boom"), {
      reference: "FFFF6666",
      log: (...args: unknown[]) => calls.push(args),
    });
    expect(calls[0]).toHaveLength(1);
    expect(typeof calls[0][0]).toBe("string");
  });

  it("writes to console.error when no log is injected, which is the real path", () => {
    // Every other test here injects a log, so the default - the only branch
    // that runs in production - was never executed. Found by CI's coverage
    // report, not by reading the file.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const report = reportFailure("prepare", new Error("upstream exploded"));
      expect(spy).toHaveBeenCalledTimes(1);
      const line = String(spy.mock.calls[0][0]);
      expect(line).toContain(report.reference);
      expect(line).toContain("upstream exploded");
    } finally {
      spy.mockRestore();
    }
  });

  it("mints a different reference each time, in a readable shape", () => {
    const a = newReference();
    const b = newReference();
    expect(a).not.toBe(b);
    // Eight uppercase hex characters: a guest reads this out or types it.
    expect(a).toMatch(/^[0-9A-F]{8}$/);
  });
});

describe("the copy makes only claims that are true (conventions §4)", () => {
  it("promises no charge on prepare, where no money has moved", () => {
    expect(guestMessage("prepare", "REF")).toMatch(/nothing has been charged/i);
  });

  it("does NOT promise that on confirm, where the card was already charged", () => {
    // The guest's card is billed in the browser BEFORE confirmBooking runs, so
    // a failure here is exactly the case where money may have moved. "Nothing
    // has been charged" would be a false claim about a guest's money.
    const message = guestMessage("confirm", "REF");
    expect(message).not.toMatch(/nothing has been charged/i);
    expect(message).toMatch(/do not pay again/i);
  });

  it("does NOT claim the booking is untouched when a cancellation fails", () => {
    // The supplier is called before we write, so a failed cancellation can mean
    // the hotel cancelled and our ledger did not record it: NOS-7's divergence.
    const message = guestMessage("cancel", "REF");
    expect(message).not.toMatch(/nothing has changed|still (active|confirmed)/i);
    expect(message).toMatch(/before trying again/i);
  });

  it("gives every scope copy with a reference and no empty message", () => {
    for (const scope of ALL_SCOPES) {
      const message = guestMessage(scope, "REF77777");
      expect(message.length, scope).toBeGreaterThan(20);
      expect(message, scope).toContain("REF77777");
    }
  });
});

describe("anything can be thrown, and the catch block must not throw (unhappy paths)", () => {
  it("describes a thrown string", () => {
    expect(describeThrown("nope")).toBe("thrown string: nope");
  });

  it("describes a rejection with no reason", () => {
    // `Promise.reject()` arrives as undefined, where `(e as Error).message`
    // read as undefined and the guest was shown nothing at all.
    expect(describeThrown(undefined)).toBe("thrown undefined");
    expect(describeThrown(null)).toBe("thrown null");
  });

  it("describes an Error with no message", () => {
    expect(describeThrown(new Error(""))).toBe("Error: (no message)");
  });

  it("names an Error whose own name has been blanked", () => {
    // A defensive fallback, and the last uncovered branch in the module: some
    // Error subclasses and some bundlers leave `name` empty, and a log line
    // reading ": boom" names nothing.
    const nameless = new Error("boom");
    (nameless as { name: string }).name = "";
    expect(describeThrown(nameless)).toBe("Error: boom");
  });

  it("describes an object, and a value whose own toString throws", () => {
    expect(describeThrown({ a: 1 })).toContain("thrown object");
    const hostile = {
      toString() {
        throw new Error("not today");
      },
    };
    expect(() => describeThrown(hostile)).not.toThrow();
    expect(describeThrown(hostile)).toBe("thrown value that could not be described");
  });

  it("still produces the full safe shape for a non-Error throw", () => {
    const lines: string[] = [];
    const report = reportFailure("payment", undefined, { log: (l) => lines.push(l) });
    expect(report.error).toContain(report.reference);
    expect(lines[0]).toContain("thrown undefined");
  });

  it("follows the cause chain, because the useful sentence is often the inner one", () => {
    const inner = new Error("ECONNREFUSED 10.0.0.1:5432");
    const outer = new Error("could not reach the database", { cause: inner });
    const described = describeThrown(outer);
    expect(described).toContain("could not reach the database");
    expect(described).toContain("ECONNREFUSED");
  });

  it("cannot hang or recurse forever on a self-referencing cause", () => {
    const loop = new Error("round and round") as Error & { cause?: unknown };
    loop.cause = loop;
    expect(describeThrown(loop)).toContain("[circular cause]");
  });

  it("truncates a dump rather than writing it to the log", () => {
    const described = describeThrown(new Error("x".repeat(9000)));
    expect(described.length).toBeLessThan(2100);
    expect(described).toMatch(/\[truncated\]$/);
  });
});

describe("what the log must not carry either", () => {
  it("redacts an email address out of the detail", () => {
    // A supplier validation error can quote the value it rejected, and
    // .agents/rules/database.md says guest personal data never goes into logs.
    const described = describeThrown(
      new Error("invalid guest email: someone@example.com rejected"),
    );
    expect(described).not.toContain("someone@example.com");
    expect(described).toContain("[email redacted]");
    // The rest of the sentence survives, so the line is still diagnosable.
    expect(described).toContain("invalid guest email");
  });

  it("redacts an email carried on a nested cause too", () => {
    const described = describeThrown(
      new Error("outer", { cause: new Error("rejected lead.guest+tag@mail.co.uk") }),
    );
    expect(described).not.toContain("@mail.co.uk");
  });
});
