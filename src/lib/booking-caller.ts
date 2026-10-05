import "server-only";

import { cookies } from "next/headers";

import { ACCESS_COOKIE, readBookingAccess } from "@/lib/booking-access";
import type { Caller } from "@/lib/booking-authz";
import { getCurrentUser } from "@/lib/dal";
import { VERIFIED_COOKIE, readVerifiedEmail } from "@/lib/guest-verify";

// THE WIRING, kept out of the rule. `mayActOnBooking`
// (src/lib/booking-authz.ts) decides; this reads the three things it decides
// from. Every one of them is resolved server-side: nothing here is taken from
// a request body, so a client cannot assert who it is.
//
// `getCurrentUser` is React-cached, so calling this alongside a page's own
// session lookup costs one session read, not two.

export async function resolveCaller(): Promise<Caller> {
  const jar = await cookies();
  const [user, verifiedEmail] = await Promise.all([
    getCurrentUser(),
    readVerifiedEmail(jar.get(VERIFIED_COOKIE)?.value),
  ]);
  return {
    userId: user?.id ?? null,
    accessIds: readBookingAccess(jar.get(ACCESS_COOKIE)?.value),
    // Belt and braces: `readVerifiedEmail` validates its own shape now, but
    // this is the boundary where an outside value becomes a typed one, and what
    // reads it is a security decision. One coercion here is cheaper than
    // trusting every future edit to that function.
    verifiedEmail: typeof verifiedEmail === "string" ? verifiedEmail : null,
  };
}
