import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

// A STATEMENT WE SIGNED AND LATER REFUSE TO BELIEVE UNLESS IT STILL CHECKS OUT.
//
// The pattern, not a new scheme: `src/lib/quote-token.ts` and
// `src/lib/guest-verify.ts` each already carry their own copy of
// "base64url payload, dot, HMAC-SHA256 over AUTH_SECRET, constant-time compare,
// expiry inside the payload". `.agents/rules/security.md` says to reuse those
// patterns rather than invent one, so this is them, extracted once, so the next
// guest-facing claim is not a fourth copy.
//
// WHAT IT IS SAFE TO PUT IN ONE. Nothing secret. The payload is signed, not
// encrypted: anyone holding the token can read it. It carries no authority of
// its own either -- it is a claim the server re-evaluates against the current
// request every time (see src/lib/booking-authz.ts). Forging one needs
// AUTH_SECRET; replaying an old one is bounded by the expiry.
//
// NOT YET USED BY quote-token.ts. Rewiring the tier guard -- which sits on the
// money path -- inside a security fix would widen the blast radius for no
// acceptance criterion. It can adopt this later, on its own ticket.

function secret(): string {
  const s = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
  // Failing loudly beats signing with a constant: a predictable key makes the
  // whole claim decorative.
  if (!s) throw new Error("AUTH_SECRET is required to sign claims");
  return s;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

/** Seal a value with an expiry. Throws only if no secret is configured. */
export function sealClaim(
  data: unknown,
  ttlSeconds: number,
  now = Date.now(),
): string {
  const payload = Buffer.from(
    JSON.stringify({ d: data, e: Math.floor(now / 1000) + ttlSeconds }),
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/**
 * The value a token carries, or null if it is missing, malformed, forged or
 * expired. Never throws: a bad claim is an ordinary "no" at the call site, and
 * a call site that has to wrap this in a try/catch will eventually forget to.
 *
 * The caller still validates the SHAPE. A signature proves we wrote the token,
 * not that an older version of this code wrote the fields this one expects.
 */
export function unsealClaim(
  token: string | null | undefined,
  now = Date.now(),
): unknown {
  if (!token || typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const given = token.slice(dot + 1);

  let expected: string;
  try {
    expected = sign(payload);
  } catch {
    return null; // no secret configured
  }

  // Constant-time. A length-varying or short-circuiting compare on a signature
  // turns forgery from a wall into a search problem.
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const { d, e } = JSON.parse(
      Buffer.from(payload, "base64url").toString(),
    ) as {
      d?: unknown;
      e?: unknown;
    };
    if (typeof e !== "number" || e * 1000 <= now) return null;
    return d ?? null;
  } catch {
    return null;
  }
}
