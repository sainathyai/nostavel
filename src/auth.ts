// Auth.js (NextAuth v5) configuration — self-hosted, portable, users live in our
// own Neon Postgres via the Drizzle adapter. Two sign-in paths for accounts:
// Google OAuth and a Resend magic-link. Guest checkout needs no account at all.
//
// Providers are added conditionally on their env vars being present, so the app
// runs before credentials exist — each provider activates the moment its keys
// land in .env.local. Sessions are DB-backed (the `sessions` table), so a login
// survives restarts and we can later revoke/inspect sessions.
import NextAuth, { type NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";
import Resend from "next-auth/providers/resend";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { db } from "@/db";
import { users, accounts, sessions, verificationTokens } from "@/db/schema";

const providers: NextAuthConfig["providers"] = [];

if (process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET) {
  providers.push(
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
    }),
  );
}

if (process.env.RESEND_API_KEY) {
  providers.push(
    Resend({
      apiKey: process.env.RESEND_API_KEY,
      from: process.env.AUTH_EMAIL_FROM || "Nostavel <onboarding@resend.dev>",
    }),
  );
}

// Names of the currently-active providers, for conditionally rendering buttons.
export const enabledProviders = providers.map((p) =>
  typeof p === "function" ? p().id : p.id,
);

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  providers,
  session: { strategy: "database" },
  pages: { signIn: "/signin" },
  trustHost: true,
  callbacks: {
    // Expose the user id to session consumers (DAL, "My trips", booking writes).
    session({ session, user }) {
      if (session.user) session.user.id = user.id;
      return session;
    },
  },
});
