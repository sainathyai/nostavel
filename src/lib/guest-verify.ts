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

async function seal(payload: object): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await hmac(body);
  return `${body}.${sig}`;
}

async function unseal<T>(token: string | undefined | null): Promise<T | null> {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!safeEqual(sig, await hmac(body))) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
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
  return seal(payload);
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
  const ch = await unseal<Challenge>(token);
  if (!ch) return { ok: false, reason: "none" };
  if (Date.now() > ch.x) return { ok: false, reason: "expired" };
  if (ch.a >= MAX_ATTEMPTS) return { ok: false, reason: "locked" };
  const c = await sha256Hex(`${code}:${email}:${secret()}`);
  if (ch.e === email && safeEqual(c, ch.c)) return { ok: true, email };
  const next: Challenge = { ...ch, a: ch.a + 1 };
  return { ok: false, reason: "mismatch", nextToken: await seal(next) };
}

export async function createVerifiedSession(email: string): Promise<string> {
  return seal({ e: email, x: Date.now() + VERIFIED_TTL_SEC * 1000 });
}

export async function readVerifiedEmail(token: string | undefined): Promise<string | null> {
  const s = await unseal<{ e: string; x: number }>(token);
  if (!s || Date.now() > s.x) return null;
  return s.e;
}
