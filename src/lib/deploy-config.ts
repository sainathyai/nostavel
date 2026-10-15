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
// NOTHING IS FATAL ON A LAPTOP, WITH TWO EXCEPTIONS. `APP_ENV` unset (or
// "local") means a developer's own machine, and every check below is skipped so
// that `npm run dev`, `npm test` and the browser smoke suite behave exactly as
// they did before this file existed — the smoke suite in particular runs a
// production build with no environment configured at all, so anything fatal by
// default would stop it loading a page. The two exceptions:
//
//   - A live supplier key is fatal everywhere, because there is no environment
//     in which this code should be pointed at real money, and "it's only my
//     laptop" is how a real charge happens by accident.
//   - A built image that has not said which environment it is, is fatal: a
//     container is never a laptop, and inheriting a laptop's exemptions by
//     omission is the one failure this whole module would not have caught.
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

/**
 * The access password, as both the strength check and the gate must read it.
 *
 * One function so the two cannot disagree: the NOS-60 security review found the
 * checks judging a trimmed value for presence and an untrimmed one for length,
 * which let thirteen spaces count towards the minimum.
 *
 * Length alone cannot tell a generated password from a memorable one -
 * `nostavel-uat-pwd` is sixteen characters. That part is the runbook's job
 * (NOS-61) and is stated as such rather than implied by this check.
 */
export function accessPassword(env: Env): string {
  return (env.ACCESS_PASSWORD ?? "").trim();
}

// Read from the environment, never logged or echoed. Each one is required for a
// shared copy to be able to do its job at all; a laptop may be missing any of
// them and simply not use that feature.
const REQUIRED_IN_SHARED: Array<{ name: string; code: string; why: string }> = [
  { name: "DATABASE_URL", code: "database-url-missing", why: "every page that reads or writes a booking" },
  { name: "AUTH_SECRET", code: "auth-secret-missing", why: "signing in, quote tokens and guest verification" },
  { name: "CRON_SECRET", code: "cron-secret-missing", why: "the sweeper and the reconciler, which protect guest money" },
  { name: "APP_URL", code: "app-url-missing", why: "links in guest email, which would otherwise point at localhost" },
  // SAME FAILURE AS APP_URL, AND IT HAPPENED. Auth.js reads AUTH_URL, not
  // APP_URL, and with neither set it built sign-in links from the container's
  // own bind address: the first guest to request a magic link got
  // `https://0.0.0.0:8080/`, because the image sets HOSTNAME=0.0.0.0 and
  // PORT=8080 as Cloud Run requires. `trustHost: true` in src/auth.ts was not
  // enough. Fatal rather than a warning for the same reason APP_URL is: a
  // deployed copy that mails dead links is not fit to serve, and a copy that
  // reports itself healthy while doing so is worse.
  { name: "AUTH_URL", code: "auth-url-missing", why: "the links in sign-in email, which would otherwise point at the container's own address" },
];

const DEGRADED_IN_SHARED: Array<{ name: string; code: string; effect: string }> = [
  { name: "ANTHROPIC_API_KEY", code: "ai-key-missing", effect: "natural-language search is unavailable" },
  { name: "RESEND_API_KEY", code: "email-key-missing", effect: "no guest email is sent, only logged" },
];

/**
 * The two variables whose VALUE, not just presence, decides whether a guest
 * gets a usable link. Both carry this environment's own origin.
 */
const URL_VARS = ["APP_URL", "AUTH_URL"] as const;

/**
 * Hosts that are never an origin a guest's browser can reach.
 *
 * `.invalid` is reserved by RFC 2606 precisely so it can never resolve, and it
 * is in this list for a concrete reason: `infra/envs/uat/variables.tf` defaults
 * `app_url` to `https://example.invalid`, and the bootstrap runbook DOCUMENTS
 * leaving it at that placeholder through the first apply, because the service's
 * URL is not knowable until the service exists.
 */
const UNREACHABLE_HOSTS = ["0.0.0.0", "localhost", "127.0.0.1", "::1", "[::1]"];

/**
 * Is this value a usable origin for a shared environment?
 *
 * A PRESENCE CHECK COULD NOT CATCH THE FAILURE IT WAS ADDED FOR, and the
 * architecture review of NOS-67 said so. The original defect was a sign-in link
 * pointing at `https://0.0.0.0:8080/`, caused by AUTH_URL being unset. Making it
 * fatal-when-missing fixed exactly that, and nothing else: `example.invalid` is
 * present, non-empty, passes the required-list loop, and reports `ok: true` -
 * while every link mailed to a guest is dead. That is the same bug with a
 * different hostname, and the runbook walks the owner straight through it.
 *
 * So the check is on the shape:
 *   - it must parse as a URL;
 *   - `https` in a shared environment, because a link we mail is a link a
 *     browser follows and a bank's app may refuse plain http;
 *   - the host must be one a guest's browser can actually reach, which rules out
 *     the container's own bind address, the loopback names, and the reserved
 *     `.invalid` suffix the bootstrap placeholder uses.
 *
 * Returns the reason it is unusable, or null when it is fine. A reason rather
 * than a boolean so the message can name what is wrong: the person reading it is
 * mid-deploy and the difference between "not a URL" and "placeholder still set"
 * is the difference between a typo and an unfinished runbook.
 *
 * NO REASON EVER ECHOES THE VALUE. The first version of this quoted the raw
 * string back ("is not a URL (...)"), which the existing secret-leak test caught
 * immediately: that test plants a sentinel in every variable and asserts no
 * problem message contains any of them. APP_URL is not a secret, so exempting it
 * would have been easy and wrong - the rule is categorical precisely so nobody
 * has to decide per variable, and the NOS-60 review had already found the weak
 * version of that test once. The host names below are literals from
 * UNREACHABLE_HOSTS, not substrings of the input, so naming them echoes our own
 * list rather than the value.
 */
export function unusableOriginReason(value: string): string | null {
  const raw = value.trim();
  if (!raw) return "is not set";

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "is not a URL";
  }

  if (url.protocol !== "https:") {
    return "is not https, and a link mailed to a guest has to be";
  }

  const host = url.hostname.toLowerCase();
  if (UNREACHABLE_HOSTS.includes(host)) {
    return "points at this container's own address, which no guest's browser can reach";
  }
  if (host === "invalid" || host.endsWith(".invalid")) {
    return "is still the bootstrap placeholder, so every link mailed to a guest is dead";
  }

  return null;
}

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

  // A BUILT IMAGE IS NEVER A LAPTOP. Raised by the NOS-60 code review, which
  // pointed out that the one case switching off almost every check below -
  // APP_ENV unset - failed silently: the health route answered `ok: true,
  // env: "local"`, indistinguishable from a developer's machine. So a container
  // deployed without APP_ENV would have had no password gate on a public URL and
  // no refusal over a missing AUTH_SECRET or APP_URL, and the one route built to
  // notice would have reported it healthy. That depended entirely on a service
  // configuration setting APP_ENV forever, on every redeploy.
  //
  // APP_SHA is the signal, because the Dockerfile bakes it in at build time and
  // nothing else ever sets it. Present with no APP_ENV means a built image that
  // has not said what it is, which is a refusal rather than a guess.
  //
  // `APP_ENV=local` with APP_SHA set stays legal on purpose: that is someone
  // running the image on their own machine on purpose, and saying so. The
  // difference this draws is between declaring a laptop and failing to declare
  // anything.
  if (!(env.APP_ENV ?? "").trim() && (env.APP_SHA ?? "").trim()) {
    problems.push({
      code: "environment-not-declared",
      severity: "fatal",
      message:
        "APP_SHA is set but APP_ENV is not, so this is a built image that has not said " +
        "which environment it is. Set APP_ENV (to \"local\" if you are running the image " +
        "yourself), rather than letting a shared copy inherit a laptop's exemptions.",
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

  // THE VALUE, NOT ONLY THE PRESENCE. See unusableOriginReason: a placeholder
  // origin is present, non-empty, and mails every guest a dead link. Only
  // checked when the value is set, so a missing variable reports once, as
  // missing, rather than twice.
  for (const name of URL_VARS) {
    const value = (env[name] ?? "").trim();
    if (!value) continue;
    const reason = unusableOriginReason(value);
    if (reason) {
      problems.push({
        code: `${name.toLowerCase().replace(/_/g, "-")}-unusable`,
        severity: "fatal",
        message: `${name} ${reason}.`,
      });
    }
  }

  // AND THAT THEY AGREE. Terraform feeds both from one variable precisely
  // because two copies of a URL drift, but nothing stopped them drifting: a
  // `gcloud run services update` can set either one alone. Diverged, sign-in
  // links and booking-email links point at different origins and an auth cookie
  // set on one host is not sent to the other, with nothing erroring. Raised by
  // the security review of NOS-67. Compared by origin, not by string, so a
  // trailing slash is not a problem (NOS-67 review, F10).
  const origins = URL_VARS.map((name) => {
    const value = (env[name] ?? "").trim();
    if (!value || unusableOriginReason(value)) return null;
    try {
      return new URL(value).origin;
    } catch {
      return null;
    }
  });
  if (origins[0] && origins[1] && origins[0] !== origins[1]) {
    problems.push({
      code: "app-auth-url-disagree",
      severity: "fatal",
      // Deliberately does not print the two origins, for the same reason as
      // above: no problem message echoes a variable's value. The health route
      // behind the operations secret is where an operator reads the values.
      message:
        "APP_URL and AUTH_URL name different origins. They are one value: a guest would " +
        "get sign-in links on one host and booking links on the other, and a cookie set " +
        "on one is not sent to the other.",
    });
  }

  // JUDGED AND COMPARED THE SAME WAY. The first draft tested `trim()` for
  // presence and raw `.length` for strength, so "abc" plus thirteen spaces
  // passed as a sixteen-character password (NOS-60 security review, L1). The
  // gate compares the trimmed value too (src/proxy.ts), so a value arriving
  // from a secret store with a trailing newline cannot validate here and then
  // lock the owner out.
  const password = accessPassword(env);
  if (!password) {
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

  // Cloud Scheduler's identity for each money-safety job (NOS-65).
  //
  // WARN, NOT FATAL, and the security review was explicit about why: fatal would
  // 503 the entire application over a cron misconfiguration, trading a dead job
  // for a dead site. A warning surfaces in `/api/health?deep=1` and in the
  // startup log, which is where a partial identity config belongs.
  //
  // PARTIAL is the case worth catching. If one of the two variables lands and the
  // other does not - a plausible partial apply, since a service account's
  // `unique_id` is a different attribute from its email - then
  // `expectedCronCaller` returns null, the OIDC path is skipped, and the job
  // silently reverts to accepting only the repository-scoped shared secret: the
  // exact credential this work exists to retire. Nothing would have said so.
  for (const job of ["SWEEP", "RECONCILE"] as const) {
    const email = (env[`CRON_${job}_INVOKER_EMAIL`] ?? "").trim();
    const subject = (env[`CRON_${job}_INVOKER_SUB`] ?? "").trim();
    const label = job.toLowerCase();
    if (email && subject) continue;
    problems.push({
      code: `cron-${label}-invoker-${email || subject ? "partial" : "missing"}`,
      severity: "warn",
      message:
        email || subject
          ? `CRON_${job}_INVOKER_EMAIL and CRON_${job}_INVOKER_SUB must both be set, and only ` +
            `one is. The ${label} job cannot be authorised by identity, so it accepts only the ` +
            "shared secret, which any workflow on any merged branch can read."
          : `CRON_${job}_INVOKER_EMAIL and CRON_${job}_INVOKER_SUB are not set, so the ` +
            `${label} job is not reachable by Cloud Scheduler and runs only from the shared ` +
            "secret.",
    });
  }

  return problems;
}

/** The subset that stops this process serving anything but its health route. */
export function fatalProblems(env: Env): ConfigProblem[] {
  return configProblems(env).filter((p) => p.severity === "fatal");
}
