"use client";

import { useActionState, useState } from "react";
import { requestGuestCode, verifyGuestCode, initialFindState } from "@/app/actions/find";

const inputClass =
  "w-full rounded-lg border border-line bg-surface px-3.5 py-2.5 text-[14px] text-ink outline-none placeholder:text-soft smooth focus-visible:border-brass";

const label = "text-[11px] font-semibold uppercase tracking-[0.1em] text-soft";

export default function FindFlow() {
  const [locState, locAction, locPending] = useActionState(requestGuestCode, initialFindState);
  const [verState, verAction, verPending] = useActionState(verifyGuestCode, initialFindState);

  // `step` follows locState.stage directly rather than being copied into its
  // own state via an effect (that copy was flagged by
  // react-hooks/set-state-in-effect, and was redundant besides — locState
  // already carries the email once a code is sent). The one thing that IS
  // real local state is "the guest chose to go back". It resets on the next
  // real submission, via the form's own action — not by comparing against a
  // stored copy of locState: holding useActionState's own return value in a
  // second useState broke static prerendering ("Server Functions cannot be
  // called during initial render"), so nothing here keeps a reference to it
  // beyond this render.
  const [wentBack, setWentBack] = useState(false);
  const step: "locate" | "code" = !wentBack && locState.stage === "code" ? "code" : "locate";
  const email = locState.email;

  if (step === "code") {
    return (
      <div className="flex w-full max-w-[440px] flex-col gap-3">
        {locState.note && (
          <p className="rounded-lg border border-sage/40 bg-sage/10 px-3.5 py-2.5 text-[13px] text-ink">
            {locState.note}
          </p>
        )}
        <form
          action={verAction}
          className="gloss flex flex-col gap-3 rounded-xl border border-line bg-surface p-5"
        >
          <input type="hidden" name="email" value={email} />
          <label className="flex flex-col gap-1">
            <span className={label}>6-digit code</span>
            <input
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              pattern="[0-9]*"
              placeholder="••••••"
              required
              autoFocus
              className={
                inputClass +
                " text-center font-mono text-[22px] tracking-[0.5em] placeholder:tracking-[0.3em]"
              }
            />
          </label>
          <p className="text-[12px] text-soft">
            Sent to <span className="text-ink">{email}</span>.
          </p>
          {verState.error && <p className="text-[13px] text-red-500">{verState.error}</p>}
          <button
            type="submit"
            disabled={verPending}
            className="btn-brass mt-1 w-full rounded-lg py-3 text-[15px] font-bold text-[#1a1410] disabled:opacity-60"
          >
            {verPending ? "Verifying…" : "See my trip"}
          </button>
        </form>
        <button
          type="button"
          onClick={() => setWentBack(true)}
          className="self-start text-[13px] text-brass underline underline-offset-2 hover:text-brassglow"
        >
          Use a different email
        </button>
      </div>
    );
  }

  return (
    <form
      action={(formData: FormData) => {
        // Clears the "went back" override on every real submission, so
        // resubmitting after clicking back correctly advances to the code
        // step again once a new code is sent.
        setWentBack(false);
        return locAction(formData);
      }}
      className="gloss flex w-full max-w-[440px] flex-col gap-3 rounded-xl border border-line bg-surface p-5"
    >
      <label className="flex flex-col gap-1">
        <span className={label}>Email on the booking</span>
        <input
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          defaultValue={locState.email}
          placeholder="you@example.com"
          required
          className={inputClass}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className={label}>Lead guest last name</span>
        <input
          name="lastName"
          autoComplete="family-name"
          placeholder="Last name"
          required
          className={inputClass}
        />
      </label>
      {locState.error && <p className="text-[13px] text-red-500">{locState.error}</p>}
      <button
        type="submit"
        disabled={locPending}
        className="btn-brass mt-1 w-full rounded-lg py-3 text-[15px] font-bold text-[#1a1410] disabled:opacity-60"
      >
        {locPending ? "Sending code…" : "Email me a code"}
      </button>
    </form>
  );
}
