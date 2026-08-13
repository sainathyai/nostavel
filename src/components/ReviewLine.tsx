export function reviewLabel(r: number) {
  if (r >= 9.5) return "Exceptional";
  if (r >= 9) return "Superb";
  if (r >= 8) return "Very good";
  if (r >= 7) return "Good";
  return "Rated";
}

// Structural (not HotelStay-specific) so both a search-result tile and a
// standalone hotel detail page — which only has room-independent identity,
// not a full HotelStay — can pass whatever shape they have.
export function ReviewLine({ stay }: { stay: { rating: number | null; reviewCount: number } }) {
  if (stay.rating == null) return null;
  return (
    <div className="flex items-center gap-1.5 text-[12px]">
      <span className="rounded bg-brass px-1.5 py-0.5 font-mono text-[11px] font-bold text-[#1a1410]">
        {stay.rating.toFixed(1)}
      </span>
      <span className="font-semibold text-ink">{reviewLabel(stay.rating)}</span>
      {stay.reviewCount > 0 && (
        <span className="text-soft">· {stay.reviewCount.toLocaleString()} reviews</span>
      )}
    </div>
  );
}
