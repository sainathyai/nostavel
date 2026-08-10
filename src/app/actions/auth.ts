"use server";

// Sign-in / sign-out server actions. `signIn`/`signOut` set the session cookie on
// the server (never client-tampered) and redirect. Called from <form action={...}>.
import { signIn, signOut } from "@/auth";

export async function signInWithGoogle() {
  await signIn("google", { redirectTo: "/" });
}

export async function signInWithEmail(formData: FormData) {
  const email = String(formData.get("email") || "").trim();
  if (!email) return;
  // Resend provider id is "resend"; sends a magic link, then redirects to verify.
  await signIn("resend", { email, redirectTo: "/" });
}

export async function signOutAction() {
  await signOut({ redirectTo: "/" });
}
