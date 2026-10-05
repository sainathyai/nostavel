import "server-only";

// Stateless guest email-verification, sealed into signed httpOnly cookies so we
// need no extra DB table. Two artifacts:
//   - a "challenge" cookie holding a HASHED one-time code + expiry + attempts
//   - a "verified" cookie proving the guest owns the email (short-lived)
// Both are HMAC-SHA256 signed with AUTH_SECRET; tampering fails verification.
// The code itself is never stored in the clear (only sha256(code:email:secret)).

const enc = new TextEncoder();

export const CHALLENGE_COOKIE = "nv_find_challenge";
export const VERIFIED_COOKIE = "nv_find_email";
export const CHALLENGE_TTL_SEC = 10 * 60;
export const VERIFIED_TTL_SEC = 30 * 60;
const MAX_ATTEMPTS = 5;

function secret(): string {
  const s = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET is not set — guest verification cannot sign cookies.");
  return s;
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

async function hmac(data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return b64url(new Uint8Array(sig));
}

async function sha256Hex(data: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(data));
  return Buffer.from(new Uint8Array(d)).toString("hex");
}

// Constant-time string compare (both are fixed-length hex/base64 here).
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// WHAT EACH COOKIE IS FOR, signed into the payload.
//
// These two artifacts used to be told apart only by their field names, and the
// challenge payload is a SUPERSET of the verified payload - `{e, c, x, a}`
// against `{e, x}` - with `e` and `x` meaning the same thing in both. So
// `readVerifiedEmail` accepted a challenge cookie and handed back the email in
// it, for the ten minutes the challenge was alive.
//
// That mattered because of who holds each one. `requestGuestCode` sets the
// challenge cookie in the jar of WHOEVER ASKED, and emails the code to the
// address on the booking. So anyone who knew a guest's email and lead last name
// was handed a token that read as proof of controlling that mailbox, without
// ever seeing the code. Found by the security-architect review of PR #33: the
// read half had been here since the /find flow shipped, and what NOS-9 added
// was a grant that turned it into a cancellation.
const CHALLENGE_PURPOSE = "find-challenge";
const VERIFIED_PURPOSE = "find-verified";

async function seal(purpose: string, payload: object): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify({ ...payload, p: purpose })));
  const sig = await hmac(body);
  return `${body}.${sig}`;
}

async function unseal<T>(purpose: string, token: string | undefined | null): Promise<T | null> {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!safeEqual(sig, await hmac(body))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { p?: unknown };
    // A valid signature proves we wrote the token, not that we wrote it for
    // THIS. Every other signed format in the codebase verifies under the same
    // key - quote tokens, booking access claims - so a reader with no check
    // here accepts all of them.
    if (!parsed || typeof parsed !== "object" || parsed.p !== purpose) return null;
    return parsed as T;
  } catch {
    return null;
  }
}

// A cryptographically-random 6-digit code (leading zeros kept).
export function makeCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return String(n).padStart(6, "0");
}

type Challenge = { e: string; c: string; x: number; a: number };

export async function createChallenge(email: string, code: string): Promise<string> {
  const c = await sha256Hex(`${code}:${email}:${secret()}`);
  const payload: Challenge = { e: email, c, x: Date.now() + CHALLENGE_TTL_SEC * 1000, a: 0 };
  return seal(CHALLENGE_PURPOSE, payload);
}

export type VerifyResult =
  | { ok: true; email: string }
  | { ok: false; reason: "none" | "expired" | "locked" | "mismatch"; nextToken?: string };

// Verify a submitted code against the sealed challenge. On a wrong-but-valid
// attempt, returns a re-sealed token with the attempt counter bumped so the
// caller can rewrite the cookie (client can't forge the counter).
export async function checkChallenge(
  token: string | undefined,
  email: string,
  code: string,
): Promise<VerifyResult> {
  const ch = await unseal<Challenge>(CHALLENGE_PURPOSE, token);
  if (!ch) return { ok: false, reason: "none" };
  // Shape before use. An expiry must be a number: `Date.now() > undefined` is
  // false, and so is every comparison against NaN, so an unchecked expiry
  // fails OPEN.
  if (typeof ch.e !== "string" || typeof ch.c !== "string" || typeof ch.x !== "number") {
    return { ok: false, reason: "none" };
  }
  if (!Number.isFinite(ch.x) || Date.now() > ch.x) return { ok: false, reason: "expired" };
  if (typeof ch.a !== "number" || ch.a >= MAX_ATTEMPTS) return { ok: false, reason: "locked" };
  const c = await sha256Hex(`${code}:${email}:${secret()}`);
  if (ch.e === email && safeEqual(c, ch.c)) return { ok: true, email };
  const next: Challenge = { ...ch, a: ch.a + 1 };
  return { ok: false, reason: "mismatch", nextToken: await seal(CHALLENGE_PURPOSE, next) };
}

export async function createVerifiedSession(email: string): Promise<string> {
  return seal(VERIFIED_PURPOSE, { e: email, x: Date.now() + VERIFIED_TTL_SEC * 1000 });
}

/**
 * The address this browser proved it controls, or null.
 *
 * Null for anything that is not a live verified cookie: another purpose's
 * token, a tampered one, an expired one, or one whose fields are not the shape
 * this code expects. The last case is not hypothetical - it is how a quote
 * token came back from here as a NUMBER typed as a string, and threw inside the
 * authorization rule that trusted the type.
 */
export async function readVerifiedEmail(token: string | undefined): Promise<string | null> {
  const s = await unseal<{ e?: unknown; x?: unknown }>(VERIFIED_PURPOSE, token);
  if (!s) return null;
  if (typeof s.e !== "string" || !s.e) return null;
  if (typeof s.x !== "number" || !Number.isFinite(s.x) || Date.now() > s.x) return null;
  return s.e;
}
