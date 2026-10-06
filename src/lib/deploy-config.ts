// What this process is allowed to be, decided from its environment alone.
//
// WHY THIS EXISTS. Until NOS-60 the app had only ever run on one laptop, where
// the person who configured it was also the person using it. A deployed copy
// has neither property: nobody is watching it start, and the consequences of a
// mistake in its configuration are paid by a guest. Two of those mistakes cost
// real money:
//
//   - A LIVE supplier key. The standing rule is that every deployed copy stays
//     on the supplier's sandbox and the live-money gate stays shut. Until now
//     that rule was enforced only by the owner being careful while pasting a
//     key — the probe scripts in analysis/ refuse to run without a `sand_`
//     prefix, but the app itself would happily take real bookings with real
//     money. This module is the app's version of that refusal.
//   - A missing APP_URL. src/lib/email.ts falls back to http://localhost:3000,
//     which is correct on a laptop and silently wrong everywhere else: every
//     confirmation and every cancellation link mailed to a guest would point at
//     their own machine. Nothing would error; the links would just be dead.
//
// FATAL VS WARN. A fatal problem means this process must not serve: src/proxy.ts
// answers 503 for every path except /api/health (which must keep answering, or
// the pipeline can see that the deploy is broken but not why). A warning means a
// feature is degraded but a guest is not endangered — no AI key means search
// falls back to its non-AI path, no email key means a send is skipped and
// logged, and both are reported by the health route rather than hidden.
//
// NOTHING IS FATAL ON A LAPTOP, WITH ONE EXCEPTION. `APP_ENV` unset (or
// "local") means a developer's own machine, and every check below is skipped so
// that `npm run dev`, `npm test` and the browser smoke suite behave exactly as
// they did before this file existed — the smoke suite in particular runs a
// production build with no environment configured at all, so anything fatal by
// default would stop it loading a page. The exception is the live supplier key:
// that one is fatal everywhere, because there is no environment in which this
// code should be pointed at real money, and "it's only my laptop" is how a real
// charge happens by accident.
//
// This module reads nothing itself — the environment is passed in — so every
// rule below is exercised by src/lib/deploy-config.test.ts rather than inferred
// from a running server. That is deliberate: the last two criticals on this
// repository both lived in branches no test could reach.
export type Env = Record<string, string | undefined>;

export type Severity = "fatal" | "warn";

export type ConfigProblem = {
  /** Stable identifier, safe to assert on in CI and in the deploy pipeline. */
  code: string;
  severity: Severity;
  /** One line, for a human reading a log or the health route. Never a secret value. */
  message: string;
};

/** What a supplier key is, judged only by its prefix (src/lib/liteapi.ts:443). */
export type SupplierMode = "sandbox" | "live" | "missing";

export const LOCAL_ENV = "local";

/**
 * Shortest access password this will accept.
 *
 * The gate exists to keep a public repository's readers off a URL that spends
 * the owner's AI credit and the supplier's sandbox quota on every search, so it
 * has to resist being guessed rather than merely exist. 16 characters of
 * generated password is far past that; a memorable one is not, and this is the
 * check that says so out loud instead of leaving it to a habit.
 */
export const MIN_ACCESS_PASSWORD_LENGTH = 16;

/** Which environment this process believes it is. Unset means a laptop. */
export function appEnv(env: Env): string {
  const raw = (env.APP_ENV ?? "").trim().toLowerCase();
  return raw || LOCAL_ENV;
}

/**
 * Is this a copy other people can reach?
 *
 * Anything that is not explicitly `local` is treated as shared, so a typo in
 * APP_ENV ("uat " / "UAT" are both fine; "ust" still counts as shared) fails
 * towards more checking rather than less.
 */
export function isSharedEnvironment(env: Env): boolean {
  return appEnv(env) !== LOCAL_ENV;
}

export function supplierMode(env: Env): SupplierMode {
  const key = (env.LITEAPI_KEY ?? "").trim();
  if (!key) return "missing";
  return key.startsWith("sand_") ? "sandbox" : "live";
}

/** Is the password gate switched on for this process? */
export function accessGateEnabled(env: Env): boolean {
  return isSharedEnvironment(env);
}

// Read from the environment, never logged or echoed. Each one is required for a
// shared copy to be able to do its job at all; a laptop may be missing any of
// them and simply not use that feature.
const REQUIRED_IN_SHARED: Array<{ name: string; code: string; why: string }> = [
  { name: "DATABASE_URL", code: "database-url-missing", why: "every page that reads or writes a booking" },
  { name: "AUTH_SECRET", code: "auth-secret-missing", why: "signing in, quote tokens and guest verification" },
  { name: "CRON_SECRET", code: "cron-secret-missing", why: "the sweeper and the reconciler, which protect guest money" },
  { name: "APP_URL", code: "app-url-missing", why: "links in guest email, which would otherwise point at localhost" },
];

const DEGRADED_IN_SHARED: Array<{ name: string; code: string; effect: string }> = [
  { name: "ANTHROPIC_API_KEY", code: "ai-key-missing", effect: "natural-language search is unavailable" },
  { name: "RESEND_API_KEY", code: "email-key-missing", effect: "no guest email is sent, only logged" },
];

/**
 * Every problem with this process's configuration, worst first.
 *
 * Order within a severity follows the lists above rather than discovery order,
 * so the same misconfiguration always reports identically — a log line a human
 * compares between two deploys is worth more than one that shuffles.
 */
export function configProblems(env: Env): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const mode = supplierMode(env);

  // Fatal in EVERY environment, laptop included. See the header.
  if (mode === "live") {
    problems.push({
      code: "supplier-key-live",
      severity: "fatal",
      message:
        "LITEAPI_KEY is not a sandbox key. Every deployed copy of this app stays on the " +
        "supplier sandbox and the live-money gate stays shut: replace it with a sand_ key.",
    });
  }

  if (!isSharedEnvironment(env)) return problems;

  if (mode === "missing") {
    problems.push({
      code: "supplier-key-missing",
      severity: "fatal",
      message: "LITEAPI_KEY is not set, so no search, price or booking can work.",
    });
  }

  for (const { name, code, why } of REQUIRED_IN_SHARED) {
    if (!(env[name] ?? "").trim()) {
      problems.push({
        code,
        severity: "fatal",
        message: `${name} is not set, and a shared environment needs it for ${why}.`,
      });
    }
  }

  const password = env.ACCESS_PASSWORD ?? "";
  if (!password.trim()) {
    problems.push({
      code: "access-password-missing",
      severity: "fatal",
      message:
        "ACCESS_PASSWORD is not set. A shared environment refuses to serve rather than " +
        "stand open: this repository is public, and every search on an open URL spends " +
        "the owner's AI credit and the supplier's sandbox quota.",
    });
  } else if (password.length < MIN_ACCESS_PASSWORD_LENGTH) {
    problems.push({
      code: "access-password-weak",
      severity: "fatal",
      message:
        `ACCESS_PASSWORD is shorter than ${MIN_ACCESS_PASSWORD_LENGTH} characters. ` +
        "Use a generated value, not a memorable one.",
    });
  }

  for (const { name, code, effect } of DEGRADED_IN_SHARED) {
    if (!(env[name] ?? "").trim()) {
      problems.push({ code, severity: "warn", message: `${name} is not set, so ${effect}.` });
    }
  }

  return problems;
}

/** The subset that stops this process serving anything but its health route. */
export function fatalProblems(env: Env): ConfigProblem[] {
  return configProblems(env).filter((p) => p.severity === "fatal");
}
