import Link from "next/link";
import { enabledProviders } from "@/auth";
import { getCurrentUser } from "@/lib/dal";
import { redirect } from "next/navigation";
import { signInWithGoogle, signInWithEmail } from "@/app/actions/auth";

// Next 16: searchParams is a Promise.
export default async function SignInPage(props: {
  searchParams: Promise<{ error?: string; sent?: string }>;
}) {
  const { error, sent } = await props.searchParams;

  // Already signed in — no reason to be here.
  const user = await getCurrentUser();
  if (user) redirect("/");

  const hasGoogle = enabledProviders.includes("google");
  const hasEmail = enabledProviders.includes("resend");
  const noneConfigured = !hasGoogle && !hasEmail;

  return (
    <main className="flex min-h-screen items-center justify-center bg-parchment px-6 py-16">
      <div className="rise w-full max-w-sm">
        <Link
          href="/"
          className="mb-8 inline-flex items-center gap-2 text-[13px] text-soft transition-colors hover:text-ink"
        >
          <span aria-hidden>←</span> Back to Nostavel
        </Link>

        <h1 className="font-display text-[30px] leading-tight text-ink">Welcome back</h1>
        <p className="mt-2 text-[14px] text-soft">
          Sign in to keep your trips in one place. You can always book as a guest without an account.
        </p>

        {error && (
          <p className="mt-5 rounded-lg border border-brass/40 bg-brass/10 px-3 py-2 text-[13px] text-ink">
            Something went wrong signing in. Please try again.
          </p>
        )}
        {sent && (
          <p className="mt-5 rounded-lg border border-sage/40 bg-sage/10 px-3 py-2 text-[13px] text-ink">
            Check your email for a sign-in link.
          </p>
        )}

        {noneConfigured ? (
          <p className="mt-8 rounded-lg border border-line bg-surface px-4 py-3 text-[13px] text-soft">
            Sign-in isn&apos;t switched on yet. Guest checkout still works — you can book without an
            account.
          </p>
        ) : (
          <div className="mt-8 flex flex-col gap-4">
            {hasGoogle && (
              <form action={signInWithGoogle}>
                <button
                  type="submit"
                  className="gloss smooth flex w-full items-center justify-center gap-2.5 rounded-lg border border-line bg-surface py-2.5 text-[14px] font-medium text-ink hover:border-brass/50 hover:bg-parchment2"
                >
                  <GoogleMark />
                  Continue with Google
                </button>
              </form>
            )}

            {hasGoogle && hasEmail && (
              <div className="flex items-center gap-3 text-[12px] text-soft">
                <span className="h-px flex-1 bg-line" />
                or
                <span className="h-px flex-1 bg-line" />
              </div>
            )}

            {hasEmail && (
              <form action={signInWithEmail} className="flex flex-col gap-2.5">
                <label htmlFor="email" className="text-[13px] text-soft">
                  Email a magic link
                </label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  required
                  placeholder="you@example.com"
                  className="rounded-lg border border-line bg-surface px-3 py-2.5 text-[14px] text-ink outline-none transition-colors focus:border-brass"
                />
                <button
                  type="submit"
                  className="btn-brass rounded-lg py-2.5 text-[14px] font-semibold text-[#1a1410]"
                >
                  Send link
                </button>
              </form>
            )}
          </div>
        )}
      </div>
    </main>
  );
}

function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden>
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}
