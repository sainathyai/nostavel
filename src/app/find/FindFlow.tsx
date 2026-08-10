"use client";

import { useActionState, useEffect, useState } from "react";
import { requestGuestCode, verifyGuestCode, initialFindState } from "@/app/actions/find";

const inputClass =
  "w-full rounded-lg border border-line bg-surface px-3.5 py-2.5 text-[14px] text-ink outline-none placeholder:text-soft smooth focus-visible:border-brass";

const label = "text-[11px] font-semibold uppercase tracking-[0.1em] text-soft";

export default function FindFlow() {
  const [step, setStep] = useState<"locate" | "code">("locate");
  const [email, setEmail] = useState("");

  const [locState, locAction, locPending] = useActionState(requestGuestCode, initialFindState);
  const [verState, verAction, verPending] = useActionState(verifyGuestCode, initialFindState);

  // When the locate step reports a code was (maybe) sent, advance to the code step.
  useEffect(() => {
    if (locState.stage === "code") {
      setEmail(locState.email);
      setStep("code");
    }
  }, [locState]);

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
          onClick={() => setStep("locate")}
          className="self-start text-[13px] text-brass underline underline-offset-2 hover:text-brassglow"
        >
          Use a different email
        </button>
      </div>
    );
  }

  return (
    <form
      action={locAction}
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
