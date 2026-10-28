// The log line's shape, which is now a contract (NOS-69).
//
// A log-based metric filters on `jsonPayload.<field>`, so where a field sits is
// not cosmetic: it is the difference between an alarm that can exist and one
// that cannot. These tests pin the shape, and `log-contract.test.ts` pins it
// against the Terraform filters that actually depend on it.
import { describe, it, expect, vi } from "vitest";
import { logCritical, logError, logInfo, logLine, logWarning, writeLine } from "./log";

const AT = new Date("2026-10-27T09:15:00.000Z");

function parse(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>;
}

describe("the shape an operator and a metric both read", () => {
  it("carries severity, event, message and a timestamp", () => {
    const entry = parse(logLine("INFO", "cron.sweep.completed", "A sweep pass completed.", {}, AT));
    expect(entry).toMatchObject({
      severity: "INFO",
      event: "cron.sweep.completed",
      message: "A sweep pass completed.",
      time: "2026-10-27T09:15:00.000Z",
    });
  });

  it("puts the caller's fields at the TOP level, not under a wrapper", () => {
    // THE WHOLE POINT. `infra/envs/uat/scheduler.tf` filters
    // `jsonPayload.via="oidc"`. Nested under a `data` key, that filter matches
    // nothing, the sweeper's absence alarm never fires again, and every test
    // but this one still passes.
    const entry = parse(logLine("INFO", "cron.sweep.completed", "Done.", { via: "oidc", recovered: 2 }, AT));
    expect(entry.via).toBe("oidc");
    expect(entry.recovered).toBe(2);
    expect(entry.data).toBeUndefined();
  });

  it("is exactly one line, because two lines are two log entries", () => {
    const line = logLine("ERROR", "x.y", "First sentence.\nSecond sentence.", { note: "a\nb" }, AT);
    expect(line).not.toContain("\n");
    expect(parse(line).message).toContain("Second sentence.");
  });

  it("does not let a caller's field displace a canonical one", () => {
    // A `{ message: ... }` field is an easy accident, and it would quietly
    // replace the sentence a human reads.
    const entry = parse(
      logLine("WARNING", "real.event", "the real message", {
        message: "hijacked",
        event: "fake.event",
        severity: "INFO",
      }, AT),
    );
    expect(entry.message).toBe("the real message");
    expect(entry.event).toBe("real.event");
    expect(entry.severity).toBe("WARNING");
  });
});

describe("personal data does not reach the log because the logger removes it", () => {
  it("redacts an email in the message", () => {
    const entry = parse(logLine("ERROR", "email.send.failed", "Rejected guest@example.com outright.", {}, AT));
    expect(entry.message).toBe("Rejected [email redacted] outright.");
  });

  it("redacts an email in a field, however deeply it sits", () => {
    // AC 4. The caller does not have to remember, which is the only version of
    // this rule that survives contact with a new call site.
    const entry = parse(
      logLine("ERROR", "x.y", "no address here", { who: "a@b.co", nested: { deeper: ["x", "c@d.org"] } }, AT),
    );
    expect(entry.who).toBe("[email redacted]");
    expect(entry.nested).toEqual({ deeper: ["x", "[email redacted]"] });
  });
});

describe("nothing a caller can pass makes the logger throw", () => {
  it("writes a bigint as text instead of refusing the line", () => {
    // `JSON.stringify` throws on a bigint, which would take the whole line out
    // from inside a catch block. Built with `BigInt()` rather than a `123n`
    // literal because this project targets below ES2020, which is also why one
    // can only arrive here from a library rather than from our own code.
    const entry = parse(logLine("INFO", "x.y", "counts", { big: BigInt("9007199254740993") }, AT));
    expect(entry.big).toBe("9007199254740993");
  });

  it("cuts a cycle rather than recursing forever", () => {
    const loop: Record<string, unknown> = { name: "outer" };
    loop.self = loop;
    const entry = parse(logLine("INFO", "x.y", "cyclic", { loop }, AT));
    expect(entry.loop).toEqual({ name: "outer", self: "[circular]" });
  });

  it("writes the same object twice when it is shared, not circular", () => {
    // A naive `seen` set would call the second one circular and lose it.
    const shared = { id: 7 };
    const entry = parse(logLine("INFO", "x.y", "shared", { a: shared, b: shared }, AT));
    expect(entry).toMatchObject({ a: { id: 7 }, b: { id: 7 } });
  });

  it("says what a non-finite number was, instead of serializing it as null", () => {
    const entry = parse(logLine("INFO", "x.y", "maths", { ratio: NaN, other: Infinity }, AT));
    expect(entry.ratio).toBe("NaN");
    expect(entry.other).toBe("Infinity");
  });

  it("survives a getter that throws", () => {
    const hostile = {
      get boom(): string {
        throw new Error("no reading this");
      },
      fine: "yes",
    };
    const entry = parse(logLine("INFO", "x.y", "hostile", { hostile }, AT));
    expect(entry.hostile).toEqual({ boom: "[threw on read]", fine: "yes" });
  });

  it("describes an Error field shallowly and redacts it", () => {
    const entry = parse(logLine("ERROR", "x.y", "failed", { cause: new Error("no row for a@b.co") }, AT));
    expect(entry.cause).toBe("Error: no row for [email redacted]");
  });

  it("renders a Date as an instant, not as an empty object", () => {
    const entry = parse(logLine("INFO", "x.y", "when", { at: AT }, AT));
    expect(entry.at).toBe("2026-10-27T09:15:00.000Z");
  });

  it("drops a field with nothing to say, and keeps an explicit null", () => {
    const entry = parse(
      logLine("INFO", "x.y", "mixed", { gone: undefined, fn: () => 1, known: null }, AT),
    );
    expect("gone" in entry).toBe(false);
    expect("fn" in entry).toBe(false);
    expect(entry.known).toBeNull();
  });

  it("stops descending instead of writing an unbounded tree", () => {
    // Four levels of object below a field are kept, which covers anything in
    // this codebase; the fifth is named rather than walked. A leaf string is
    // never cut, only a further object.
    const keptWhole = { a: { b: { c: { d: "leaf" } } } };
    expect(JSON.stringify(parse(logLine("INFO", "x.y", "deep", keptWhole, AT)).a)).toContain("leaf");

    const tooDeep = { a: { b: { c: { d: { e: { f: "unreachable" } } } } } };
    expect(JSON.stringify(parse(logLine("INFO", "x.y", "deep", tooDeep, AT)).a)).toContain("[nested too deep]");
  });

  it("samples a long array and says how much it left out", () => {
    const entry = parse(logLine("INFO", "x.y", "many", { ids: Array.from({ length: 60 }, (_, i) => i) }, AT));
    expect((entry.ids as unknown[]).length).toBe(51);
    expect((entry.ids as unknown[]).at(-1)).toBe("[10 more]");
  });

  it("truncates a string long enough to be a dump", () => {
    const entry = parse(logLine("INFO", "x.y", "big", { blob: "x".repeat(5000) }, AT));
    expect(String(entry.blob)).toHaveLength(2000 + "... [truncated]".length);
  });
});

describe("severity decides the stream as well as the field", () => {
  // The payload's `severity` is what Cloud Logging honours, and it is what the
  // assertions below check. The stream still matters for everything that does
  // not parse JSON: a local terminal, `docker logs`, a test spy.
  function captured(run: () => void): { error: string[]; warn: string[]; info: string[] } {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      run();
      return {
        error: error.mock.calls.map((c) => String(c[0])),
        warn: warn.mock.calls.map((c) => String(c[0])),
        info: info.mock.calls.map((c) => String(c[0])),
      };
    } finally {
      error.mockRestore();
      warn.mockRestore();
      info.mockRestore();
    }
  }

  it("sends INFO to stdout and names it INFO", () => {
    const { info } = captured(() => logInfo("x.y", "fine"));
    expect(parse(info[0]).severity).toBe("INFO");
  });

  it("sends a WARNING to stderr but does NOT call it an error", () => {
    // The behaviour change this ticket is really about: every warning in this
    // app arrived as ERROR, because that is what Cloud Logging infers from the
    // stream when the payload is silent.
    const { warn } = captured(() => logWarning("x.y", "odd"));
    expect(parse(warn[0]).severity).toBe("WARNING");
  });

  it("sends ERROR and CRITICAL to stderr, distinguishably", () => {
    const { error } = captured(() => {
      logError("x.y", "broken");
      logCritical("x.z", "not serving");
    });
    expect(error.map((line) => parse(line).severity)).toEqual(["ERROR", "CRITICAL"]);
  });

  it("swallows a console that throws, rather than failing the caller", () => {
    // Logging happens inside catch blocks and in a sweeper rescuing a payment.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("stdout is gone");
    });
    try {
      expect(() => writeLine("ERROR", "{}")).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});
