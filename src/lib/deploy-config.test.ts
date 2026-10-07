import { describe, it, expect } from "vitest";
import {
  accessGateEnabled,
  accessPassword,
  appEnv,
  configProblems,
  fatalProblems,
  isSharedEnvironment,
  MIN_ACCESS_PASSWORD_LENGTH,
  supplierMode,
  type Env,
} from "./deploy-config";

// Fake credentials are assembled at runtime, never written as literals
// (docs/conventions.md §6): the committed text of this file must not match the
// guard's own LiteAPI pattern, or the guard that protects this public repository
// would block its own test suite.
const SANDBOX_KEY = "sand" + "_" + "k".repeat(24);
const LIVE_KEY = "prod" + "_" + "k".repeat(24);
const PASSWORD = "p".repeat(MIN_ACCESS_PASSWORD_LENGTH);

/** A shared environment with nothing wrong with it. */
function healthyShared(overrides: Env = {}): Env {
  return {
    APP_ENV: "uat",
    LITEAPI_KEY: SANDBOX_KEY,
    DATABASE_URL: "present",
    AUTH_SECRET: "present",
    CRON_SECRET: "present",
    APP_URL: "https://example.invalid",
    ACCESS_PASSWORD: PASSWORD,
    ANTHROPIC_API_KEY: "present",
    RESEND_API_KEY: "present",
    ...overrides,
  };
}

function codes(env: Env): string[] {
  return configProblems(env).map((p) => p.code);
}

describe("appEnv", () => {
  it("treats an unset environment as a developer's own machine", () => {
    expect(appEnv({})).toBe("local");
  });

  it("ignores surrounding space and letter case, so a typed value still matches", () => {
    expect(appEnv({ APP_ENV: "  LOCAL " })).toBe("local");
    expect(appEnv({ APP_ENV: "UAT" })).toBe("uat");
  });

  it("treats an empty value as unset rather than as an environment named nothing", () => {
    expect(appEnv({ APP_ENV: "   " })).toBe("local");
  });
});

describe("isSharedEnvironment", () => {
  it("is false only for the local environment", () => {
    expect(isSharedEnvironment({})).toBe(false);
    expect(isSharedEnvironment({ APP_ENV: "local" })).toBe(false);
  });

  it("treats a misspelled environment name as shared, so a typo adds checks rather than removing them", () => {
    // The dangerous direction is a value that was MEANT to be a deployed
    // environment being read as a laptop, which would switch off every check
    // below. Anything unrecognised therefore counts as shared.
    expect(isSharedEnvironment({ APP_ENV: "locl" })).toBe(true);
    expect(isSharedEnvironment({ APP_ENV: "uat" })).toBe(true);
    expect(isSharedEnvironment({ APP_ENV: "production" })).toBe(true);
  });
});

describe("supplierMode", () => {
  it("reads a sandbox key by its prefix", () => {
    expect(supplierMode({ LITEAPI_KEY: SANDBOX_KEY })).toBe("sandbox");
  });

  it("calls anything that is not a sandbox key live, rather than guessing at the prefix", () => {
    // The only safe default: a key whose prefix we do not recognise must not be
    // assumed harmless, because being wrong in that direction spends real money.
    expect(supplierMode({ LITEAPI_KEY: LIVE_KEY })).toBe("live");
    expect(supplierMode({ LITEAPI_KEY: "something-else-entirely" })).toBe("live");
  });

  it("distinguishes a missing key from a live one", () => {
    expect(supplierMode({})).toBe("missing");
    expect(supplierMode({ LITEAPI_KEY: "  " })).toBe("missing");
  });

  it("reads a padded key the same way the supplier client does", () => {
    // M2 of the NOS-60 security review. This rule used to exist twice: here,
    // trimmed, and in src/lib/liteapi.ts, untrimmed. A key pasted into a secret
    // store with a leading space would have passed the gate as `sandbox` while
    // the supplier client decided `live` and fetched the supplier's LIVE payment
    // account for the guest's browser. There is now one definition, which
    // liteapi.ts imports, and it trims.
    expect(supplierMode({ LITEAPI_KEY: " " + SANDBOX_KEY })).toBe("sandbox");
    expect(supplierMode({ LITEAPI_KEY: SANDBOX_KEY + "\n" })).toBe("sandbox");
    expect(supplierMode({ LITEAPI_KEY: "  " + LIVE_KEY + "  " })).toBe("live");
  });
});

describe("accessGateEnabled", () => {
  it("is off on a laptop and on everywhere else", () => {
    expect(accessGateEnabled({})).toBe(false);
    expect(accessGateEnabled({ APP_ENV: "uat" })).toBe(true);
  });
});

describe("configProblems on a developer's own machine", () => {
  it("reports nothing at all when every variable is missing", () => {
    // The whole point of the local exemption: `npm run dev`, `npm test` and the
    // browser smoke suite (which runs a production build with no environment
    // configured) must behave exactly as they did before this module existed.
    expect(configProblems({})).toEqual([]);
  });

  it("still refuses a live supplier key, because no machine should be pointed at real money", () => {
    expect(codes({ LITEAPI_KEY: LIVE_KEY })).toEqual(["supplier-key-live"]);
    expect(configProblems({ LITEAPI_KEY: LIVE_KEY })[0].severity).toBe("fatal");
  });

  it("accepts a sandbox key with nothing else configured", () => {
    expect(configProblems({ LITEAPI_KEY: SANDBOX_KEY })).toEqual([]);
  });
});

describe("configProblems for a built image", () => {
  // The silent failure found by the NOS-60 code review: APP_ENV is the one value
  // whose absence switches off nearly every check here, and nothing in the image
  // sets it - it comes from the deployment's service configuration, on every
  // redeploy, forever. Dropped once, a shared copy would have inherited a
  // laptop's exemptions: no password gate on a public URL, no refusal over a
  // missing AUTH_SECRET or APP_URL, and a health route answering `ok: true`.
  const SHA = "abc1234";

  it("refuses to serve when APP_SHA is baked in but APP_ENV was never set", () => {
    expect(codes({ APP_SHA: SHA, LITEAPI_KEY: SANDBOX_KEY })).toEqual(["environment-not-declared"]);
  });

  it("accepts the same image when it declares itself local, which is a person running it on purpose", () => {
    // The permissive direction. The distinction being drawn is between declaring
    // a laptop and failing to declare anything - not between a container and a
    // laptop, which nothing can tell apart with certainty.
    expect(configProblems({ APP_SHA: SHA, APP_ENV: "local", LITEAPI_KEY: SANDBOX_KEY })).toEqual([]);
  });

  it("says nothing about a laptop that has no image behind it", () => {
    // `npm run dev`, the unit suite and the browser smoke suite all run with
    // neither variable set, and none of them may be affected by this rule.
    expect(configProblems({ LITEAPI_KEY: SANDBOX_KEY })).toEqual([]);
    expect(configProblems({ APP_SHA: "   ", LITEAPI_KEY: SANDBOX_KEY })).toEqual([]);
  });

  it("reports an undeclared image alongside a live key rather than instead of it", () => {
    expect(codes({ APP_SHA: SHA, LITEAPI_KEY: LIVE_KEY })).toEqual([
      "supplier-key-live",
      "environment-not-declared",
    ]);
  });

  it("says nothing about a declared shared environment, which is the normal case", () => {
    expect(configProblems(healthyShared({ APP_SHA: SHA }))).toEqual([]);
  });
});

describe("configProblems in a shared environment", () => {
  it("reports nothing when everything is set", () => {
    expect(configProblems(healthyShared())).toEqual([]);
  });

  it("refuses a live supplier key", () => {
    expect(codes(healthyShared({ LITEAPI_KEY: LIVE_KEY }))).toEqual(["supplier-key-live"]);
  });

  it("refuses a missing supplier key separately, so the log says which of the two it is", () => {
    expect(codes(healthyShared({ LITEAPI_KEY: undefined }))).toEqual(["supplier-key-missing"]);
  });

  it.each([
    ["DATABASE_URL", "database-url-missing"],
    ["AUTH_SECRET", "auth-secret-missing"],
    ["CRON_SECRET", "cron-secret-missing"],
    ["APP_URL", "app-url-missing"],
  ])("refuses to serve when %s is missing", (name, code) => {
    expect(codes(healthyShared({ [name]: undefined }))).toEqual([code]);
  });

  it("treats a variable set to whitespace as missing", () => {
    expect(codes(healthyShared({ DATABASE_URL: "   " }))).toEqual(["database-url-missing"]);
  });

  it("refuses to serve with no access password, rather than standing open", () => {
    expect(codes(healthyShared({ ACCESS_PASSWORD: undefined }))).toEqual(["access-password-missing"]);
  });

  it("refuses a password short enough to guess", () => {
    expect(codes(healthyShared({ ACCESS_PASSWORD: "p".repeat(MIN_ACCESS_PASSWORD_LENGTH - 1) }))).toEqual([
      "access-password-weak",
    ]);
  });

  it("accepts a password at exactly the minimum length", () => {
    // The boundary in the permissive direction, so the rule cannot drift into
    // rejecting the value the runbook tells the owner to generate.
    expect(configProblems(healthyShared({ ACCESS_PASSWORD: PASSWORD }))).toEqual([]);
  });

  it("reports every fatal problem at once, so one deploy log names them all", () => {
    const problems = codes(healthyShared({ DATABASE_URL: undefined, CRON_SECRET: undefined, ACCESS_PASSWORD: "" }));
    expect(problems).toEqual(["database-url-missing", "cron-secret-missing", "access-password-missing"]);
  });

  it("warns, but does not refuse, when a degraded feature's key is missing", () => {
    // A guest is not endangered by either of these, and refusing to serve over
    // them would make the environment harder to stand up than it is to keep
    // safe. Both are reported, so neither is a silent surprise.
    const problems = configProblems(healthyShared({ ANTHROPIC_API_KEY: undefined, RESEND_API_KEY: undefined }));
    expect(problems.map((p) => [p.code, p.severity])).toEqual([
      ["ai-key-missing", "warn"],
      ["email-key-missing", "warn"],
    ]);
    expect(fatalProblems(healthyShared({ ANTHROPIC_API_KEY: undefined, RESEND_API_KEY: undefined }))).toEqual([]);
  });

  it("puts the fatal problems before the warnings", () => {
    const severities = configProblems(
      healthyShared({ DATABASE_URL: undefined, RESEND_API_KEY: undefined }),
    ).map((p) => p.severity);
    expect(severities).toEqual(["fatal", "warn"]);
  });

  it("never puts a secret value in a message, whichever variable it came from", () => {
    // These messages reach a process log and, behind the operations secret, the
    // health route. Naming the variable is the help; echoing its value is a leak.
    //
    // A UNIQUE SENTINEL IN EVERY VARIABLE. The first version of this test
    // planted two, and left the other five set to the literal "present" - so a
    // message that echoed DATABASE_URL or CRON_SECRET would have passed it. The
    // NOS-60 security review named that as the same shape as the weak assertion
    // that hid a critical on the previous branch: an assertion that is also true
    // when the code is wrong.
    const sentinels: Record<string, string> = {
      LITEAPI_KEY: LIVE_KEY,
      DATABASE_URL: "sentinel-database-value",
      AUTH_SECRET: "sentinel-auth-value",
      CRON_SECRET: "sentinel-cron-value",
      APP_URL: "sentinel-appurl-value",
      ACCESS_PASSWORD: "sentinel-pw",
      ANTHROPIC_API_KEY: "sentinel-ai-value",
      RESEND_API_KEY: "sentinel-email-value",
    };

    // Every variable present and every one absent, so both the "is set but
    // wrong" and the "is missing" message paths are covered.
    const everythingSet = { APP_ENV: "uat", ...sentinels };
    const everythingShort = { APP_ENV: "uat", ACCESS_PASSWORD: "sentinel-pw", LITEAPI_KEY: LIVE_KEY };

    for (const env of [everythingSet, everythingShort]) {
      const problems = configProblems(env);
      expect(problems.length).toBeGreaterThan(0); // or this test asserts nothing
      for (const problem of problems) {
        for (const value of Object.values(sentinels)) {
          expect(problem.message).not.toContain(value);
        }
      }
    }
  });

  it("measures the password after trimming, so spaces cannot pad it to the minimum", () => {
    // L1 of the NOS-60 security review: presence was judged on a trimmed value
    // and strength on the raw one, so "abc" plus thirteen spaces counted as a
    // sixteen-character password.
    const padded = "abc" + " ".repeat(MIN_ACCESS_PASSWORD_LENGTH - 3);
    expect(padded.length).toBe(MIN_ACCESS_PASSWORD_LENGTH);
    expect(codes(healthyShared({ ACCESS_PASSWORD: padded }))).toEqual(["access-password-weak"]);
  });

  it("accepts a good password that arrived with surrounding whitespace", () => {
    // The other direction, and the one that would lock the owner out: a value
    // copied out of a secret store with a trailing newline must not validate
    // here and then fail at the gate. Both read it through `accessPassword`.
    expect(configProblems(healthyShared({ ACCESS_PASSWORD: "  " + PASSWORD + "\n" }))).toEqual([]);
    expect(accessPassword({ ACCESS_PASSWORD: "  " + PASSWORD + "\n" })).toBe(PASSWORD);
  });
});
