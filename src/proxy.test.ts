import { describe, it, expect, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

// WHY THIS FILE EXISTS. `requestVerdict` was already well tested, and the NOS-60
// security review pointed out that this proved almost nothing about the
// deployed behaviour: nothing anywhere asserted an HTTP status from the gate,
// and - its example - swapping `process.env.ACCESS_PASSWORD` for
// `process.env.CRON_SECRET` on the line that feeds the rule passed the entire
// suite, the linter, the type-checker and the build. The rule was tested; the
// wiring that chooses its inputs, which is the part that can be wrong silently,
// had no coverage at all.
//
// That is the same shape as the two criticals on the previous branch: a correct
// rule reached through a wrong branch. So this tests the seam - which variable
// reaches which parameter, and what status and headers come back.
//
// `next/server` imports cleanly under vitest and `NextResponse.next()` is
// identifiable (status 200 plus an `x-middleware-next` header), so none of this
// needs a running server.

const SANDBOX_KEY = "sand" + "_" + "k".repeat(24);
const LIVE_KEY = "prod" + "_" + "k".repeat(24);
const GATE_PASSWORD = "gate" + "-" + "p".repeat(20);
const OPS_SECRET = "ops" + "-" + "s".repeat(20);

const SAVED = { ...process.env };

afterEach(() => {
  process.env = { ...SAVED };
  vi.restoreAllMocks();
});

/** Replace the environment wholesale, so a stray real value cannot leak in. */
function environment(vars: Record<string, string>): void {
  process.env = { NODE_ENV: "test", ...vars } as NodeJS.ProcessEnv;
}

function shared(overrides: Record<string, string> = {}): void {
  environment({
    APP_ENV: "uat",
    APP_SHA: "abc1234",
    LITEAPI_KEY: SANDBOX_KEY,
    DATABASE_URL: "present",
    AUTH_SECRET: "present",
    CRON_SECRET: OPS_SECRET,
    APP_URL: "https://example.invalid",
    ACCESS_PASSWORD: GATE_PASSWORD,
    ...overrides,
  });
}

function request(path: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("https://example.invalid" + path, { headers });
}

function basic(password: string): Record<string, string> {
  return { authorization: "Basic " + Buffer.from("owner:" + password).toString("base64") };
}

/** Did the proxy hand the request on to the application? */
function passedThrough(response: Response): boolean {
  return response.status === 200 && response.headers.get("x-middleware-next") === "1";
}

describe("a developer's own machine", () => {
  it("passes every request through, with nothing configured", () => {
    environment({});
    expect(passedThrough(proxy(request("/")))).toBe(true);
    expect(passedThrough(proxy(request("/book/abc")))).toBe(true);
  });
});

describe("the password gate, as the deployed copy applies it", () => {
  it("challenges a visitor with no credentials, and says how to answer", () => {
    shared();
    const res = proxy(request("/"));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Basic realm="/);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("passes a request carrying the right password", () => {
    shared();
    expect(passedThrough(proxy(request("/", basic(GATE_PASSWORD))))).toBe(true);
  });

  it("reads the gate password, and not some other secret this process holds", () => {
    // THE TEST THE SECURITY REVIEW ASKED FOR BY NAME. With the gate fed from the
    // wrong variable, every case above still passes - the rule is correct, the
    // statuses are right, and the only symptom is that the operations secret
    // opens the environment while the password the owner was given does not.
    // Two distinct values, and both directions asserted.
    shared();
    expect(proxy(request("/", basic(OPS_SECRET))).status).toBe(401);
    expect(passedThrough(proxy(request("/", basic(GATE_PASSWORD))))).toBe(true);
  });

  it("accepts a password that arrived from a secret store with surrounding whitespace", () => {
    // The gate and the strength check read the password through one function, so
    // a trailing newline cannot validate at startup and then lock the owner out.
    shared({ ACCESS_PASSWORD: "  " + GATE_PASSWORD + "\n" });
    expect(passedThrough(proxy(request("/", basic(GATE_PASSWORD))))).toBe(true);
  });

  it("leaves a trace of a refusal, without recording what was tried", () => {
    // An unthrottled dictionary attack on a public URL should at least be
    // visible afterwards (NOS-62 is the rate limit itself). The guess is a
    // credential that may be someone's real password somewhere else, so it must
    // never reach a log.
    shared();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    proxy(request("/book/abc", { ...basic("hunter2"), "x-forwarded-for": "203.0.113.7, 10.0.0.1" }));
    expect(warn).toHaveBeenCalledOnce();
    const line = warn.mock.calls[0][0] as string;
    expect(line).toContain("/book/abc");
    expect(line).toContain("203.0.113.7");
    expect(line).not.toContain("hunter2");
  });
});

describe("the routes that carry their own secret", () => {
  it("passes them through without the password", () => {
    shared();
    expect(passedThrough(proxy(request("/api/cron/sweep")))).toBe(true);
    expect(passedThrough(proxy(request("/api/cron/reconcile")))).toBe(true);
    expect(passedThrough(proxy(request("/api/webhooks/liteapi")))).toBe(true);
  });

  it("challenges a route that does not exist yet under the same prefix", () => {
    shared();
    expect(proxy(request("/api/cron/warm-search")).status).toBe(401);
  });
});

describe("a copy holding a live supplier key", () => {
  it("refuses every path, including for the caller holding the password", () => {
    shared({ LITEAPI_KEY: LIVE_KEY });
    expect(proxy(request("/")).status).toBe(503);
    expect(proxy(request("/", basic(GATE_PASSWORD))).status).toBe(503);
    expect(proxy(request("/book/abc")).status).toBe(503);
  });

  it("refuses the scheduled jobs too, so nothing of ours calls a live supplier", () => {
    shared({ LITEAPI_KEY: LIVE_KEY });
    expect(proxy(request("/api/cron/sweep")).status).toBe(503);
    expect(proxy(request("/api/webhooks/liteapi")).status).toBe(503);
  });

  it("still passes the health route, so the pipeline can find out why", () => {
    shared({ LITEAPI_KEY: LIVE_KEY });
    expect(passedThrough(proxy(request("/api/health")))).toBe(true);
  });

  it("does not say in the response which part of the configuration is wrong", async () => {
    // The problem list names the exact secret a deployed copy is missing, so it
    // goes to the process log and to /api/health?deep=1 behind the operations
    // secret - not to whoever knocked.
    shared({ LITEAPI_KEY: LIVE_KEY });
    const body = await proxy(request("/")).text();
    expect(body).not.toContain("LITEAPI");
    expect(body).not.toContain("supplier-key-live");
    expect(body).not.toContain(LIVE_KEY);
  });
});

describe("a built image that was never told which environment it is", () => {
  it("refuses to serve rather than passing as a laptop", () => {
    // Both NOS-60 review gates found this independently. The image now defaults
    // APP_ENV to a non-local value (Dockerfile), and an image that declares
    // nothing at all - APP_ENV="" overriding that default - is fatal too. This
    // asserts the second half, which is the one the Dockerfile cannot cover.
    environment({ APP_SHA: "abc1234", APP_ENV: "", LITEAPI_KEY: SANDBOX_KEY });
    expect(proxy(request("/")).status).toBe(503);
  });

  it("serves when a person runs the image and says it is local", () => {
    environment({ APP_SHA: "abc1234", APP_ENV: "local", LITEAPI_KEY: SANDBOX_KEY });
    expect(passedThrough(proxy(request("/")))).toBe(true);
  });
});

describe("a shared copy missing a secret it needs", () => {
  it("refuses to serve, rather than failing in the middle of a booking", () => {
    shared({ DATABASE_URL: "" });
    expect(proxy(request("/")).status).toBe(503);
  });

  it("refuses to stand open when no access password is set", () => {
    shared({ ACCESS_PASSWORD: "" });
    expect(proxy(request("/")).status).toBe(503);
  });

  it("refuses a password short enough to guess", () => {
    shared({ ACCESS_PASSWORD: "short" });
    expect(proxy(request("/")).status).toBe(503);
  });
});
