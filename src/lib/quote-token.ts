import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

// Proof of WHICH TIER a page was priced at, carried by the page itself.
//
// THE HOLE THIS FILLS. A rendered stay page holds offerIds that LiteAPI priced
// at whichever margin the session implied (pricing.ts). Sign out in another tab
// and that page keeps its member-priced offerIds in client memory; clicking Book
// then records userId=null against a member-priced offer, and the checkout
// identity guard sees null === null and waves it through. The tier the offer was
// priced at is simply not knowable server-side from the offerId.
//
// WHY NOT STORE THE OFFER SET. Measured 2026-08-22: an offerId is 904-1772 bytes
// (median 1200), and one search returns 276 of them. Binding offers by storing
// them costs ~324 KB per search, a third of the whole response body, plus a TTL
// sweep. A signed claim about the PAGE costs about a hundred bytes and no
// storage at all, because the client is holding it for us.
//
// WHY THIS IS SAFE TO HAND TO THE CLIENT. It carries no secret and grants
// nothing: it is a statement we signed, that we later refuse to accept unless it
// still matches the live session. Forging it needs AUTH_SECRET. Replaying an old
// one is bounded by `exp`, and a captured member token is useless to a signed-out
// visitor because verification compares the claim against the CURRENT session,
// not against the token alone.

const TTL_SECONDS = 30 * 60;

export type Tier = "member" | "public";

function secret(): string {
  const s = process.env.AUTH_SECRET;
  // Failing loudly beats signing with a constant. A predictable key would make
  // the whole token decorative.
  if (!s) throw new Error("AUTH_SECRET is required to sign quote tokens");
  return s;
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

/**
 * Issue a token stating the tier a page was priced at. Call it in the same
 * server render that chose the margin, so the two can never disagree.
 */
export function signQuote(tier: Tier, now = Date.now()): string {
  const payload = b64url(JSON.stringify({ t: tier, e: Math.floor(now / 1000) + TTL_SECONDS }));
  return `${payload}.${sign(payload)}`;
}

/**
 * The tier a token claims, or null if it is missing, malformed, forged or
 * expired. Never throws: a bad token is an ordinary "no" at the call site.
 */
export function readQuote(token: string | null | undefined, now = Date.now()): Tier | null {
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
  // Constant-time: a length-varying or short-circuiting compare on a signature
  // is the classic way to make forgery a search problem rather than a wall.
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const { t, e } = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      t?: unknown;
      e?: unknown;
    };
    if (t !== "member" && t !== "public") return null;
    if (typeof e !== "number" || e * 1000 <= now) return null;
    return t;
  } catch {
    return null;
  }
}

/**
 * Does a page's claimed tier still match who is asking?
 *
 * Both directions are rejected. member-token + signed-out is the revenue leak.
 * public-token + signed-in would charge a member the public rate, which is ours
 * to fix rather than theirs to absorb.
 */
export function quoteMatchesSession(
  token: string | null | undefined,
  isMember: boolean,
  now = Date.now(),
): boolean {
  const tier = readQuote(token, now);
  if (tier === null) return false;
  return tier === (isMember ? "member" : "public");
}
