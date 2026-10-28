// What makes a log line an error report, and what must never become one (NOS-70).
import { describe, it, expect, vi, afterEach } from "vitest";
import { onRequestError } from "@/instrumentation";
import { reportFailure } from "./action-error";
import { pathOnly, reportError, reportFields, reportedMessage, serviceContext, stackOf } from "./error-report";
import { logError } from "./log";
import { rateLimit, type RateStore } from "./rate-limit-store";

const REPORTED = "type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent";

/** Run something and return every ERROR/WARNING line it wrote, parsed. */
function linesFrom(run: () => void | Promise<void>): Promise<Record<string, unknown>[]> {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  return Promise.resolve(run())
    .then(() =>
      [...error.mock.calls, ...warn.mock.calls].map((call) => JSON.parse(String(call[0])) as Record<string, unknown>),
    )
    .finally(() => {
      error.mockRestore();
      warn.mockRestore();
    });
}

const ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ENV };
});

describe("an unexpected exception becomes one group with a count (AC 1)", () => {
  it("types the payload and puts the stack in the message", async () => {
    // Error Reporting takes an entry whose payload is a ReportedErrorEvent, and
    // groups it by the stack in `message`. Both, so an error with a stack is
    // grouped properly and one without is still taken.
    const [entry] = await linesFrom(() =>
      reportError("request.failed", "Unhandled error in route GET /api/hotels.", new Error("upstream exploded")),
    );

    expect(entry["@type"]).toBe(REPORTED);
    expect(entry.severity).toBe("ERROR");
    expect(String(entry.message)).toContain("Unhandled error in route GET /api/hotels.");
    expect(String(entry.message)).toContain("Error: upstream exploded");
    expect(String(entry.message)).toMatch(/\n\s+at /);
  });

  it("names the build and the environment, so `which copy` is not a guess (AC 2)", async () => {
    process.env.K_SERVICE = "nostavel-uat";
    process.env.APP_SHA = "0b77e0bd1c2d3e4f";
    const [entry] = await linesFrom(() => reportError("request.failed", "broken", new Error("x")));
    expect(entry.serviceContext).toEqual({ service: "nostavel-uat", version: "0b77e0bd1c2d3e4f" });
  });

  it("falls back to the app environment when Cloud Run has not named the service", () => {
    expect(serviceContext({ APP_ENV: "uat" })).toEqual({
      service: "nostavel-uat",
      version: "unknown",
    });
    expect(serviceContext({}).service).toBe("nostavel-local");
  });

  it("gives a stackless throw something stable to group by", async () => {
    // `throw "nope"` is legal and arrives here. Without a stack Error Reporting
    // needs a report location, or every occurrence is its own group.
    const [entry] = await linesFrom(() => reportError("webhook.dispatch.failed", "no stack here", "nope"));
    expect(entry.context).toEqual({
      reportLocation: { filePath: "unknown", lineNumber: 0, functionName: "webhook.dispatch.failed" },
    });
  });

  it("omits the report location when there IS a stack, which groups better", () => {
    expect(reportFields("x.y", new Error("boom")).context).toBeUndefined();
  });
});

describe("the error Next caught for us, which no catch block of ours sees", () => {
  const request = {
    path: "/find/trips?email=guest%40example.com&ref=ABC",
    method: "GET",
    headers: { cookie: "nostavel_session=secret-value", authorization: "Basic hunter2" },
  };
  const context = {
    routerKind: "App Router" as const,
    routePath: "/app/find/trips/page.tsx",
    routeType: "render" as const,
    revalidateReason: undefined,
  };

  it("reports a thrown server error with where it happened", async () => {
    const [entry] = await linesFrom(() => onRequestError(new Error("db unreachable"), request, context));
    expect(entry).toMatchObject({
      severity: "ERROR",
      event: "request.failed",
      "@type": REPORTED,
      method: "GET",
      routeType: "render",
      routePath: "/app/find/trips/page.tsx",
    });
    expect(String(entry.message)).toContain("Error: db unreachable");
  });

  it("keeps the query string and every header out of the line", async () => {
    // The query carries a guest's email on this very route, and the headers
    // carry the session cookie and the access-gate credential.
    const [entry] = await linesFrom(() => onRequestError(new Error("db unreachable"), request, context));
    const whole = JSON.stringify(entry);

    expect(entry.path).toBe("/find/trips");
    expect(whole).not.toContain("email=");
    expect(whole).not.toContain("secret-value");
    expect(whole).not.toContain("hunter2");
  });

  it("carries the digest, which is all a guest can read off the screen", async () => {
    // React replaces the thrown instance while rendering a server component, so
    // the digest is the only thing tying "it said digest 1234567890" to a line.
    const replaced = Object.assign(new Error("An error occurred in the Server Components render."), {
      digest: "1234567890",
    });
    const [entry] = await linesFrom(() => onRequestError(replaced, request, context));
    expect(entry.digest).toBe("1234567890");
  });

  it("survives a thrown value that is not an object at all", async () => {
    const lines = await linesFrom(() => onRequestError(undefined, request, context));
    expect(lines).toHaveLength(1);
    expect(lines[0].digest).toBeUndefined();
  });

  it("strips a query string only when there is one", () => {
    expect(pathOnly("/api/hotels")).toBe("/api/hotels");
    expect(pathOnly("/api/hotels?q=a?b")).toBe("/api/hotels");
    expect(pathOnly("")).toBe("");
  });
});

describe("a handled failure is reported too, with the guest's reference on it (AC 3)", () => {
  it("puts the reference in the fields and in the sentence", () => {
    const lines: string[] = [];
    const report = reportFailure("confirm", new Error("LiteAPI 400"), { log: (l) => lines.push(l) });
    const entry = JSON.parse(lines[0]) as Record<string, unknown>;

    expect(entry["@type"]).toBe(REPORTED);
    expect(entry.reference).toBe(report.reference);
    expect(entry.scope).toBe("confirm");
    // Which is the id the guest was shown, so one search finds both.
    expect(report.error).toContain(report.reference);
    expect(String(entry.message)).toContain(report.reference);
  });
});

describe("what must NOT be reported (AC 4)", () => {
  it("an ERROR line is not an error report on its own", async () => {
    // Severity and reporting are separate on purpose: ERROR says this request
    // failed, a report says nobody expected it.
    const [entry] = await linesFrom(() => logError("rate_limit.store_unavailable", "failing closed"));
    expect(entry.severity).toBe("ERROR");
    expect(entry["@type"]).toBeUndefined();
    expect(String(entry.message)).not.toMatch(/\n\s+at /);
  });

  it("a rate-limit outage is logged and not reported, however often it happens", async () => {
    const broken: RateStore = {
      async hit() {
        throw new Error('relation "rate_limits" does not exist');
      },
    };
    const lines = await linesFrom(async () => {
      await rateLimit("booking-confirm:ip:1.2.3.4", { limit: 1, windowMs: 60_000, onStoreError: "deny" }, broken);
    });

    expect(lines).toHaveLength(1);
    expect(lines[0].event).toBe("rate_limit.store_unavailable");
    expect(lines[0]["@type"]).toBeUndefined();
  });
});

describe("nothing here can make a failure worse", () => {
  it("does not throw on a value whose stack cannot be read", () => {
    const hostile = new Proxy(new Error("boom"), {
      get(target, prop) {
        if (prop === "stack") throw new Error("no stack for you");
        return Reflect.get(target, prop);
      },
    });
    expect(stackOf(hostile)).toBeNull();
    expect(() => reportedMessage("headline", hostile)).not.toThrow();
  });

  it("redacts a guest's address out of a reported stack (AC 5)", async () => {
    const [entry] = await linesFrom(() =>
      reportError("action.failed", "guest failed", new Error("no booking for guest@example.com")),
    );
    expect(String(entry.message)).toContain("[email redacted]");
    expect(JSON.stringify(entry)).not.toContain("guest@example.com");
  });
});
