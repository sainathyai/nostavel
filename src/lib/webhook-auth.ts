// Constant-time comparison for a bearer-style shared secret — the LiteAPI
// webhook's `authorization` header and the cron routes' `Authorization:
// Bearer <CRON_SECRET>` both use this.
//
// There is no signature scheme documented for LiteAPI webhooks (see
// using-liteapi-webhooks.md) — the header value IS the whole control. A naive
// `===` compare leaks timing information proportional to how many leading
// bytes match, turning forgery from "guess a 32-byte secret" into "guess it
// one byte at a time." Pulled out of quote-token.ts's identical pattern
// rather than duplicated inline.
import "server-only";
import { timingSafeEqual } from "node:crypto";

export function verifySharedSecret(
  received: string | null | undefined,
  expected: string | undefined,
): boolean {
  if (!expected || !received) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch rather than returning false —
  // guard it explicitly so a wrong-length header doesn't 500.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
