import type { AmenityKey } from "@/lib/liteapi";

// Icon-only amenity glyphs for search-result tiles — no label text on the
// tile itself; the `title` attribute carries the name for a11y/tooltip.
export const AMENITY_LABEL: Record<AmenityKey, string> = {
  parking: "Parking",
  breakfast: "Breakfast",
  wifi: "Free WiFi",
  kitchenette: "Kitchenette",
  microwave: "Microwave",
  fridge: "Refrigerator",
  accessible: "Accessible",
  pool: "Pool",
  gym: "Fitness center",
  pet: "Pet friendly",
  ac: "Air conditioning",
  spa: "Spa",
  restaurant: "Restaurant",
  bar: "Bar",
  laundry: "Laundry",
};

const STROKE = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

function Glyph({ kind, size }: { kind: AmenityKey; size: number }) {
  switch (kind) {
    case "parking":
      return (
        <svg viewBox="0 0 24 24" width={size} height={size} {...STROKE}>
          <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
          <text x="12" y="16.5" textAnchor="middle" fontSize="11" fontWeight="700" stroke="none" fill="currentColor">
            P
          </text>
        </svg>
      );
    case "breakfast":
      return (
        <svg viewBox="0 0 24 24" width={size} height={size} {...STROKE}>
          <path d="M5 8h11v6a5.5 5.5 0 0 1-5.5 5.5H10.5A5.5 5.5 0 0 1 5 14V8Z" />
          <path d="M16 9.5h1.5a2.5 2.5 0 0 1 0 5H16" />
          <path d="M8 3.5c-.6.8-.6 1.4 0 2M11.5 3.5c-.6.8-.6 1.4 0 2" />
        </svg>
      );
    case "wifi":
      return (
        <svg viewBox="0 0 24 24" width={size} height={size} {...STROKE}>
          <path d="M4 9.5a12 12 0 0 1 16 0" />
          <path d="M7.2 13a8 8 0 0 1 9.6 0" />
          <path d="M10.3 16.4a4 4 0 0 1 3.4 0" />
          <circle cx="12" cy="19" r="0.9" fill="currentColor" stroke="none" />
        </svg>
      );
    case "kitchenette":
      return (
        <svg viewBox="0 0 24 24" width={size} height={size} {...STROKE}>
          <path d="M4.5 11.5h15a7.5 5 0 0 1-15 0Z" />
          <path d="M8 9c0-2 1-3 1-4.5M13 9c0-2 1-3 1-4.5" />
          <path d="M4.5 11.5V16M19.5 11.5V16" />
        </svg>
      );
    case "microwave":
      return (
        <svg viewBox="0 0 24 24" width={size} height={size} {...STROKE}>
          <rect x="3.5" y="6" width="17" height="12" rx="1.5" />
          <rect x="6" y="8.5" width="8" height="7" rx="0.8" />
          <circle cx="17.5" cy="10.5" r="0.9" fill="currentColor" stroke="none" />
          <line x1="16" y1="14" x2="19" y2="14" />
        </svg>
      );
    case "fridge":
      return (
        <svg viewBox="0 0 24 24" width={size} height={size} {...STROKE}>
          <rect x="6" y="3" width="12" height="18" rx="1.8" />
          <line x1="6" y1="9.5" x2="18" y2="9.5" />
          <line x1="9" y1="6" x2="9" y2="7.3" />
          <line x1="9" y1="12" x2="9" y2="13.3" />
        </svg>
      );
    case "accessible":
      return (
        <svg viewBox="0 0 24 24" width={size} height={size} {...STROKE}>
          <circle cx="12" cy="4.8" r="1.6" fill="currentColor" stroke="none" />
          <path d="M12 7.5v5l4.5 2M12 12.5H8" />
          <path d="M9.5 12.5 8.2 19" />
          <circle cx="8.5" cy="16" r="4" />
        </svg>
      );
    case "pool":
      return (
        <svg viewBox="0 0 24 24" width={size} height={size} {...STROKE}>
          <path d="M3 9V5.5M21 9V5.5M3 9c1.4 1.2 2.6 1.2 4 0s2.6-1.2 4 0 2.6 1.2 4 0 2.6-1.2 4 0" />
          <path d="M3 14c1.4 1.2 2.6 1.2 4 0s2.6-1.2 4 0 2.6 1.2 4 0 2.6-1.2 4 0" />
          <path d="M3 19c1.4 1.2 2.6 1.2 4 0s2.6-1.2 4 0 2.6 1.2 4 0 2.6-1.2 4 0" />
        </svg>
      );
    case "gym":
      return (
        <svg viewBox="0 0 24 24" width={size} height={size} {...STROKE}>
          <line x1="4" y1="12" x2="20" y2="12" />
          <rect x="2.5" y="9" width="3" height="6" rx="1" />
          <rect x="18.5" y="9" width="3" height="6" rx="1" />
        </svg>
      );
    case "pet":
      return (
        <svg viewBox="0 0 24 24" width={size} height={size} {...STROKE}>
          <ellipse cx="12" cy="16" rx="4.5" ry="3.6" />
          <circle cx="6" cy="10" r="1.5" />
          <circle cx="10" cy="6.5" r="1.5" />
          <circle cx="14" cy="6.5" r="1.5" />
          <circle cx="18" cy="10" r="1.5" />
        </svg>
      );
    case "ac":
      return (
        <svg viewBox="0 0 24 24" width={size} height={size} {...STROKE}>
          <line x1="12" y1="3" x2="12" y2="21" />
          <line x1="4.9" y1="6.5" x2="19.1" y2="17.5" />
          <line x1="19.1" y1="6.5" x2="4.9" y2="17.5" />
        </svg>
      );
    case "spa":
      return (
        <svg viewBox="0 0 24 24" width={size} height={size} {...STROKE}>
          <path d="M12 3c3.5 3.6 5.5 6.9 5.5 9.8a5.5 5.5 0 1 1-11 0C6.5 9.9 8.5 6.6 12 3Z" />
        </svg>
      );
    case "restaurant":
      return (
        <svg viewBox="0 0 24 24" width={size} height={size} {...STROKE}>
          <path d="M7 3v7a2 2 0 0 0 4 0V3M9 10v11M9 3v3M5 3v3" />
          <path d="M16.5 3c-1.5 0-2.5 1.6-2.5 4s1 4 2.5 4V21" />
        </svg>
      );
    case "bar":
      return (
        <svg viewBox="0 0 24 24" width={size} height={size} {...STROKE}>
          <path d="M4.5 4h15L12 13z" />
          <line x1="12" y1="13" x2="12" y2="20" />
          <line x1="8" y1="20" x2="16" y2="20" />
        </svg>
      );
    case "laundry":
      return (
        <svg viewBox="0 0 24 24" width={size} height={size} {...STROKE}>
          <rect x="3.5" y="3.5" width="17" height="17" rx="2.5" />
          <circle cx="12" cy="13.5" r="4.8" />
          <circle cx="6.5" cy="6.3" r="0.7" fill="currentColor" stroke="none" />
          <circle cx="9" cy="6.3" r="0.7" fill="currentColor" stroke="none" />
        </svg>
      );
  }
}

export function AmenityIcon({ kind, size = 15 }: { kind: AmenityKey; size?: number }) {
  return (
    <span title={AMENITY_LABEL[kind]} className="text-soft transition-colors group-hover:text-ink">
      <Glyph kind={kind} size={size} />
    </span>
  );
}
