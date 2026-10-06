import { describe, it, expect } from "vitest";
import { buildHealth } from "./health";
import type { Env } from "./deploy-config";

const SANDBOX_KEY = "sand" + "_" + "k".repeat(24);
const LIVE_KEY = "prod" + "_" + "k".repeat(24);

function shared(overrides: Env = {}): Env {
  return {
    APP_ENV: "uat",
    APP_SHA: "abc1234",
    LITEAPI_KEY: SANDBOX_KEY,
    DATABASE_URL: "present",
    AUTH_SECRET: "present",
    CRON_SECRET: "present",
    APP_URL: "https://example.invalid",
    ACCESS_PASSWORD: "p".repeat(20),
    ANTHROPIC_API_KEY: "present",
    RESEND_API_KEY: "present",
    ...overrides,
  };
}

describe("the answer anyone may have", () => {
  it("says it is healthy, which build it is, and which environment", () => {
    expect(buildHealth({ env: shared(), detail: false, database: "not-checked" })).toEqual({
      ok: true,
      env: "uat",
      sha: "abc1234",
    });
  });

  it("reveals nothing about what is wrong, only that something is", () => {
    // The problem list names the exact secret a deployed copy is missing, which
    // is a map of its weaknesses. Anyone may learn that this copy is unhealthy;
    // only the operations secret buys the reason.
    const health = buildHealth({ env: shared({ DATABASE_URL: undefined }), detail: false, database: "not-checked" });
    expect(health.ok).toBe(false);
    expect(Object.keys(health).sort()).toEqual(["env", "ok", "sha"]);
  });

  it("does not tell a stranger which copy has a live supplier key engaged", () => {
    // Raised by the NOS-60 code review: `supplier` is not a secret value, but it
    // tells an anonymous caller which deployed copy is worth spending effort on,
    // which is the same kind of signal as the problem list and belongs on the
    // same side of the line. The copy still answers that it is unhealthy.
    const health = buildHealth({ env: shared({ LITEAPI_KEY: LIVE_KEY }), detail: false, database: "not-checked" });
    expect(health.ok).toBe(false);
    expect(health).not.toHaveProperty("supplier");
  });

  it("says the build is unknown rather than inventing one, when it was not baked in", () => {
    expect(buildHealth({ env: shared({ APP_SHA: undefined }), detail: false, database: "not-checked" }).sha).toBe(
      "unknown",
    );
    expect(buildHealth({ env: shared({ APP_SHA: "  " }), detail: false, database: "not-checked" }).sha).toBe("unknown");
  });
});

describe("the answer behind the operations secret", () => {
  it("adds the supplier mode, the problem list and the database result", () => {
    expect(buildHealth({ env: shared(), detail: true, database: "ok" })).toEqual({
      ok: true,
      env: "uat",
      sha: "abc1234",
      supplier: "sandbox",
      problems: [],
      database: "ok",
    });
  });

  it("reports a live supplier key, which is what stops the pipeline promoting it", () => {
    // The second of the two layers: the environment refuses to serve every
    // request (src/proxy.ts), and the delivery pipeline refuses to move traffic
    // to it. This is the signal the pipeline reads, and it holds the operations
    // secret, so it is on the detailed side.
    const health = buildHealth({ env: shared({ LITEAPI_KEY: LIVE_KEY }), detail: true, database: "ok" });
    expect(health).toMatchObject({ ok: false, supplier: "live" });
    expect(health.problems.map((p) => p.code)).toContain("supplier-key-live");
  });

  it("names each problem by a code the pipeline can assert on", () => {
    const health = buildHealth({ env: shared({ CRON_SECRET: undefined }), detail: true, database: "ok" });
    expect(health.problems.map((p) => p.code)).toEqual(["cron-secret-missing"]);
  });

  it("reports a degraded feature without calling the copy unhealthy", () => {
    const health = buildHealth({ env: shared({ RESEND_API_KEY: undefined }), detail: true, database: "ok" });
    expect(health.ok).toBe(true);
    expect(health.problems.map((p) => [p.code, p.severity])).toEqual([["email-key-missing", "warn"]]);
  });
});

describe("the database probe", () => {
  it("makes an otherwise healthy copy unhealthy when the database cannot be reached", () => {
    // A copy that starts, holds every secret, and cannot reach its database is
    // a copy that will fail on the first page a guest opens. The pipeline must
    // not move traffic to it.
    const health = buildHealth({ env: shared(), detail: true, database: "unreachable" });
    expect(health.ok).toBe(false);
  });

  it("does not hold a copy's health against a probe that was never run", () => {
    expect(buildHealth({ env: shared(), detail: false, database: "not-checked" }).ok).toBe(true);
  });
});

describe("a developer's own machine", () => {
  it("is healthy with nothing configured at all", () => {
    expect(buildHealth({ env: {}, detail: true, database: "not-checked" })).toEqual({
      ok: true,
      env: "local",
      sha: "unknown",
      supplier: "missing",
      problems: [],
      database: "not-checked",
    });
  });
});

describe("a built image that has not said what it is", () => {
  it("is reported unhealthy rather than passing as a laptop", () => {
    // The failure the NOS-60 code review found: with APP_ENV dropped from a
    // deployed copy, this route used to answer `ok: true, env: "local"` -
    // indistinguishable from a developer's machine, on a URL with no password
    // gate. The route built to catch a misconfiguration reported healthy.
    const health = buildHealth({ env: { APP_SHA: "abc1234", LITEAPI_KEY: SANDBOX_KEY }, detail: true, database: "ok" });
    expect(health.ok).toBe(false);
    expect(health.problems.map((p) => p.code)).toEqual(["environment-not-declared"]);
  });
});
