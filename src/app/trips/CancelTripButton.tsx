"use client";

// Two-step cancel: the first click reveals the exact penalty (computed
// server-side from the SAME stored cancellationPolicy that priced the
// booking, never re-derived here) and asks for a second click. Showing the
// number before asking for confirmation is the actual requirement from
// docs/production-readiness.md §2.1 ("gated on the policy ladder ... showing
// the exact penalty BEFORE confirming").
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cancelBookingAction } from "@/app/actions/booking";

export default function CancelTripButton({
  bookingId,
  refundable,
  freeUntilLong,
  tierLines,
}: {
  bookingId: string;
  refundable: boolean;
  freeUntilLong: string | null;
  tierLines: string[];
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ refunded: boolean } | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  if (done) {
    return (
      <p className="text-[13px] text-soft">
        {done.refunded ? "Cancelled — a refund has been issued." : "Cancelled — this rate was non-refundable."}
      </p>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-full border border-line px-3 py-1.5 text-[13px] text-soft hover:border-red-400 hover:text-red-500"
      >
        Cancel booking
      </button>
    );
  }

  return (
    <div className="w-full rounded-xl border border-line bg-parchment p-4">
      <p className="text-[13px] font-medium text-ink">
        {refundable
          ? `Free to cancel until ${freeUntilLong}.`
          : "This rate is non-refundable — cancelling forfeits the amount below."}
      </p>
      {tierLines.length > 0 && (
        <ul className="mt-1.5 flex flex-col gap-0.5 text-[12px] text-soft">
          {tierLines.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      )}
      {error && <p className="mt-2 text-[13px] text-red-500">{error}</p>}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              setError(null);
              const res = await cancelBookingAction(bookingId);
              if (res.ok) {
                setDone({ refunded: res.data.refunded });
                router.refresh();
              } else {
                setError(res.error);
              }
            })
          }
          className="rounded-full bg-red-500 px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-60"
        >
          {pending ? "Cancelling…" : "Confirm cancellation"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={pending}
          className="rounded-full border border-line px-3 py-1.5 text-[13px] text-soft hover:text-ink"
        >
          Never mind
        </button>
      </div>
    </div>
  );
}
