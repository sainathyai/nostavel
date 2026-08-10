"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { rateLimit } from "@/lib/rate-limit";
import { findConfirmedBookingsByEmailAndLastName } from "@/lib/bookings";
import { sendGuestCode } from "@/lib/email";
import {
  CHALLENGE_COOKIE,
  VERIFIED_COOKIE,
  CHALLENGE_TTL_SEC,
  VERIFIED_TTL_SEC,
  makeCode,
  createChallenge,
  checkChallenge,
  createVerifiedSession,
} from "@/lib/guest-verify";

// A single state shape drives a two-step client form:
//   stage "locate" -> collect email + last name
//   stage "code"   -> collect the 6-digit code
export type FindState = {
  stage: "locate" | "code";
  email: string;
  note: string | null;
  error: string | null;
};

export const initialFindState: FindState = { stage: "locate", email: "", note: null, error: null };

// Same message whether or not anything matched — the flow must never reveal
// whether an email/last-name pair corresponds to a real booking.
const SENT_NOTE =
  "If that email and last name match a booking, we sent a 6-digit code. It expires in 10 minutes.";

function cookieOpts(maxAgeSec: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: maxAgeSec,
  };
}

async function clientIp(): Promise<string> {
  const h = await headers();
  return (h.get("x-forwarded-for") ?? "").split(",")[0]?.trim() || "local";
}

// Step 1: locate a booking by email + lead last name, and (if found) email a code.
export async function requestGuestCode(_prev: FindState, formData: FormData): Promise<FindState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const lastName = String(formData.get("lastName") ?? "").trim();

  if (!email || !lastName) {
    return {
      stage: "locate",
      email,
      note: null,
      error: "Enter the email on the booking and the lead guest's last name.",
    };
  }

  const ip = await clientIp();
  const perIp = rateLimit(`find-send:ip:${ip}`, { limit: 6, windowMs: 15 * 60_000 });
  const perEmail = rateLimit(`find-send:email:${email}`, { limit: 4, windowMs: 15 * 60_000 });
  if (!perIp.ok || !perEmail.ok) {
    return {
      stage: "locate",
      email,
      note: null,
      error: "Too many requests. Please wait a few minutes and try again.",
    };
  }

  try {
    const matches = await findConfirmedBookingsByEmailAndLastName(email, lastName);
    if (matches.length > 0) {
      const code = makeCode();
      const jar = await cookies();
      jar.set(CHALLENGE_COOKIE, await createChallenge(email, code), cookieOpts(CHALLENGE_TTL_SEC));
      await sendGuestCode(email, code);
      if (process.env.NODE_ENV !== "production") {
        // Dev-only: the Resend sandbox only delivers to the account owner, so
        // surface the code in the server log to keep the flow testable.
        console.log(`[find] verification code for ${email}: ${code}`);
      }
    }
  } catch (e) {
    // Never leak existence via an error path — log and fall through to the note.
    console.error("[find] requestGuestCode failed:", (e as Error).message);
  }

  return { stage: "code", email, note: SENT_NOTE, error: null };
}

// Step 2: verify the code. On success, set a short-lived verified-email session
// and redirect to the guest trips list.
export async function verifyGuestCode(_prev: FindState, formData: FormData): Promise<FindState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const code = String(formData.get("code") ?? "").replace(/\D/g, "");

  if (!email) return { ...initialFindState, error: "Something went wrong. Please start again." };
  if (code.length !== 6) {
    return { stage: "code", email, note: null, error: "Enter the 6-digit code from your email." };
  }

  const ip = await clientIp();
  const rl = rateLimit(`find-verify:ip:${ip}`, { limit: 12, windowMs: 15 * 60_000 });
  if (!rl.ok) {
    return { stage: "code", email, note: null, error: "Too many attempts. Please wait a few minutes." };
  }

  const jar = await cookies();
  const res = await checkChallenge(jar.get(CHALLENGE_COOKIE)?.value, email, code);

  if (res.ok) {
    jar.delete(CHALLENGE_COOKIE);
    jar.set(VERIFIED_COOKIE, await createVerifiedSession(email), cookieOpts(VERIFIED_TTL_SEC));
    redirect("/find/trips");
  }

  // Persist the bumped attempt counter so it can't be reset by the client.
  if (res.reason === "mismatch" && res.nextToken) {
    jar.set(CHALLENGE_COOKIE, res.nextToken, cookieOpts(CHALLENGE_TTL_SEC));
  }
  const error =
    res.reason === "expired"
      ? "That code has expired. Request a new one below."
      : res.reason === "locked"
        ? "Too many wrong codes. Request a new one below."
        : res.reason === "none"
          ? "Your code session expired. Start again."
          : "That code doesn't match. Check your email and try again.";
  return { stage: "code", email, note: null, error };
}
