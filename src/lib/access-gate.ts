// Who is allowed to reach a shared copy of this app, and what it answers when
// its own configuration is broken.
//
// WHY A GATE AT ALL. This repository is public, so a deployed URL is a URL
// strangers will find. Every natural-language search on it spends the owner's AI
// credit; every booking attempt consumes the supplier's sandbox quota and writes
// rows into the same ledger the owner is trying to accept a change in. A test
// environment with no gate is a bill and a polluted dataset, not a test
// environment.
//
// WHY HTTP BASIC, AND NOT A LOGIN PAGE. Basic needs no page, no form, no cookie,
// no session and no new way to get authentication wrong — the browser holds the
// credential and re-sends it, and the whole mechanism is one header. A styled
// password page would be nicer to look at and would add a page, a form action, a
// cookie and a CSRF question to a change that sits in front of the money path.
// This is a lock on a test environment, not a product surface. If it ever needs
// to become one, `requestVerdict` is the only thing that has to change.
//
// WHAT IS DELIBERATELY NOT BEHIND THE GATE:
//
//   - /api/health — the deploy pipeline has to be able to ask an unhealthy copy
//     what is wrong with it. Answered for anyone; the detail that could help an
//     attacker needs the operations secret (see src/app/api/health/route.ts).
//   - /api/webhooks/** — the supplier cannot log in. It already authenticates
//     with a shared secret compared in constant time (src/lib/webhook-auth.ts).
//   - /api/cron/** — same, for the scheduler. These two routes are the
//     abandoned-hold sweeper and the nightly reconciler: the sweeper is the only
//     thing that rescues a guest who was charged and whose browser never came
//     back, so locking it out would disable the exact money-safety job this
//     deployment exists to switch on.
//
// Each of those paths carries its own credential, so exempting them moves no
// trust; forgetting to exempt them would have quietly broken guest-money
// recovery, which is why there is a test per path rather than one for the list.
//
// ONE DECISION, ONE FUNCTION. `requestVerdict` is the whole rule, and
// src/proxy.ts is wiring. Both criticals found on the previous branch lived in a
// branch of a page that no test could reach; this keeps the ordering of "broken
// configuration beats a valid password" somewhere a test can see it.
import type { ConfigProblem } from "./deploy-config";

/** Matched exactly: /api/healthcheck or /api/health-internal are NOT this route. */
const EXEMPT_EXACT = ["/api/health"];

/** Matched as a prefix, trailing slash included so /api/cronjobs is not /api/cron/. */
const EXEMPT_PREFIXES = ["/api/webhooks/", "/api/cron/"];

export type Verdict =
  /** Serve it. */
  | { action: "allow" }
  /** 503: this process is misconfigured and must not serve. */
  | { action: "unavailable"; problems: ConfigProblem[] }
  /** 401 with a Basic challenge. */
  | { action: "challenge" };

export type VerdictInput = {
  /** Request pathname, already normalized by the framework (no query, no origin). */
  path: string;
  /** Fatal configuration problems, from src/lib/deploy-config.ts. */
  fatal: ConfigProblem[];
  /** Is the password gate switched on for this process? */
  gateEnabled: boolean;
  /** Raw `authorization` request header, if any. */
  authorization: string | null;
  /** The configured password. */
  password: string | undefined;
  /**
   * Constant-time comparison, injected rather than imported: it keeps this
   * module free of node:crypto (so it stays a pure rule with a trivial test)
   * and keeps the one real implementation in src/lib/webhook-auth.ts rather
   * than growing a second copy here. `===` on a secret is a timing oracle —
   * .agents/rules/security.md forbids it.
   */
  matches: (received: string | null, expected: string | undefined) => boolean;
};

/**
 * Does this path authenticate itself, and so never see the password gate?
 *
 * A path containing `..` is never exempt. The framework normalizes the pathname
 * before this sees it, so this is defence against a future config change
 * (skipProxyUrlNormalize) rather than today's behaviour — and the safe answer
 * for a path we cannot read plainly is "not exempt".
 */
export function isExemptPath(path: string): boolean {
  if (path.includes("..")) return false;
  if (EXEMPT_EXACT.includes(path)) return true;
  return EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * The password out of an `Authorization: Basic ...` header, or null.
 *
 * The username is ignored on purpose: a second shared string adds no secrecy
 * and one more thing for the owner to mistype. Everything after the first colon
 * is the password, because a colon is legal inside one.
 */
export function parseBasicPassword(authorization: string | null): string | null {
  if (!authorization) return null;
  const [scheme, ...rest] = authorization.trim().split(/\s+/);
  if (!scheme || scheme.toLowerCase() !== "basic" || rest.length !== 1) return null;

  let decoded: string;
  try {
    decoded = Buffer.from(rest[0], "base64").toString("utf8");
  } catch {
    return null;
  }

  const colon = decoded.indexOf(":");
  if (colon === -1) return null;
  return decoded.slice(colon + 1);
}

/**
 * What to do with one request. The order of these rules is the point.
 *
 * Health first, so a broken copy can still be diagnosed. Then configuration,
 * so a copy holding a live supplier key refuses everyone — including someone
 * holding the correct password, who would otherwise be able to make a real
 * booking with real money. Only then the gate.
 */
export function requestVerdict(input: VerdictInput): Verdict {
  if (EXEMPT_EXACT.includes(input.path)) return { action: "allow" };

  if (input.fatal.length > 0) return { action: "unavailable", problems: input.fatal };

  if (!input.gateEnabled) return { action: "allow" };
  if (isExemptPath(input.path)) return { action: "allow" };

  const received = parseBasicPassword(input.authorization);
  return input.matches(received, input.password) ? { action: "allow" } : { action: "challenge" };
}
