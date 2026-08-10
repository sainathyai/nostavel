// Server-only LiteAPI client. The key lives here and never reaches the browser.
// Field paths below were verified against the live sandbox (see probe results):
//   search:  data[].roomTypes[].offerId / .offerRetailRate.amount / .suggestedSellingPrice.amount
//   prebook: data.prebookId / .price / .priceDifferencePercent / .cancellationChanged

import "server-only";
import { DEST_BY_KEY } from "./destinations";
import { US_CITY_SET } from "./us-cities";
import { INTL_CITY_BY_DEST } from "./intl-cities";
import { memberPrice } from "./pricing";

const BASE = process.env.LITEAPI_BASE_URL || "https://api.liteapi.travel/v3.0";
const KEY = process.env.LITEAPI_KEY || "";

type Json = Record<string, unknown> | unknown[];

async function api(
  method: string,
  path: string,
  opts: { body?: unknown; params?: Record<string, string | number> } = {},
): Promise<any> {
  if (!KEY) throw new Error("LITEAPI_KEY missing. Add it to .env.local");
  let url = BASE + path;
  if (opts.params) {
    const q = new URLSearchParams(
      Object.entries(opts.params).map(([k, v]) => [k, String(v)]),
    );
    url += "?" + q.toString();
  }
  const res = await fetch(url, {
    method,
    headers: {
      "X-API-Key": KEY,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    cache: "no-store", // rates are live; never cache the transactional calls
  });
  const data = (await res.json().catch(() => ({}))) as Json;
  if (!res.ok) {
    const msg = (data as any)?.error?.message || JSON.stringify(data);
    throw new Error(`LiteAPI ${res.status}: ${msg}`);
  }
  return data;
}

// ---- types the UI consumes ----
export type Category = "budget" | "comfort" | "luxury" | "convenience";

export type HotelStay = {
  id: string;
  name: string;
  city: string;
  address: string;
  stars: number;
  photo: string | null;
  offerId: string;
  you: number; // your retail price (total)
  them: number | null; // Booking.com suggested price
  currency: string;
  room: string;
  board: string;
  freeCancel: boolean;
  feeAtHotel: number; // mandatory fee collected at the hotel (0 if none/bundled)
  rating: number | null; // 0-10 guest score
  reviewCount: number;
  lat: number | null;
  lng: number | null;
  categories: Category[]; // computed relative to the result set
};

export type Collection = {
  key: string;
  title: string;
  blurb: string;
  city: string;
  items: HotelStay[];
};

// ---- data endpoints ----
async function listHotelsByRadius(lat: number, lng: number, radius: number, limit = 30) {
  const d = await api("GET", "/data/hotels", {
    params: { latitude: lat, longitude: lng, radius, limit },
  });
  return (d.data ?? d) as any[];
}

async function listHotelsByCity(cityName: string, countryCode: string, limit = 30) {
  const d = await api("GET", "/data/hotels", {
    params: { countryCode, cityName, limit },
  });
  return (d.data ?? d) as any[];
}

// A search target is either a perimeter (curated hotspot) or a plain city name.
export type SearchTarget =
  | { kind: "radius"; name: string; lat: number; lng: number; radius: number }
  | { kind: "city"; name: string; city: string; country: string };

// Resolve a `dest` param to a target: curated key -> perimeter, else a city
// (bare name -> US, the original dataset; "intl:CC:Name" -> the global tier).
export function resolveDest(dest: string): SearchTarget | null {
  const c = DEST_BY_KEY.get(dest);
  if (c) return { kind: "radius", name: c.name, lat: c.lat, lng: c.lng, radius: c.radius };
  if (US_CITY_SET.has(dest)) return { kind: "city", name: dest, city: dest, country: "US" };
  const intl = INTL_CITY_BY_DEST.get(dest);
  if (intl) return { kind: "city", name: intl.c, city: intl.c, country: intl.cc };
  return null;
}

async function searchRates(
  hotelIds: string[],
  checkin: string,
  checkout: string,
  maxRatesPerHotel = 1,
) {
  const d = await api("POST", "/hotels/rates", {
    body: {
      hotelIds,
      occupancies: [{ adults: 2 }],
      currency: "USD",
      guestNationality: "US",
      checkin,
      checkout,
      maxRatesPerHotel,
    },
  });
  return (d.data ?? d) as any[];
}

async function hotelDetail(hotelId: string) {
  const d = await api("GET", "/data/hotel", { params: { hotelId } });
  return (d as any).data ?? d;
}

async function hotelReviews(hotelId: string, limit = 8) {
  try {
    const d = await api("GET", "/data/reviews", { params: { hotelId, limit } });
    return ((d as any).data ?? d ?? []) as any[];
  } catch {
    return [];
  }
}

// ---- the four-step booking flow (prebook/book used by the drawer via API routes) ----
// usePaymentSdk=true makes LiteAPI the merchant of record: the response carries a
// `secretKey` + `transactionId` for a browser card session (the guest's card is
// charged by LiteAPI, not us). Default false keeps the old wallet path.
export async function prebook(offerId: string, usePaymentSdk = false) {
  const d = await api("POST", "/rates/prebook", {
    body: { offerId, usePaymentSdk },
  });
  return (d as any).data ?? d;
}

// Finalize. When a transactionId is present (the Payment SDK path) we book against
// that charge with method TRANSACTION_ID; otherwise we fall back to the sandbox
// wallet method (no card).
export async function book(input: {
  prebookId: string;
  firstName: string;
  lastName: string;
  email: string;
  transactionId?: string | null;
}) {
  const payment = input.transactionId
    ? { method: "TRANSACTION_ID", transactionId: input.transactionId }
    : { method: "ACC_CREDIT_CARD" };
  const d = await api("POST", "/rates/book", {
    body: {
      prebookId: input.prebookId,
      holder: { firstName: input.firstName, lastName: input.lastName, email: input.email },
      guests: [
        {
          occupancyNumber: 1,
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.email,
        },
      ],
      payment,
    },
  });
  return (d as any).data ?? d;
}

// The Stripe publishable key for LiteAPI's payment account, from their payment
// wrapper's config endpoint. Public by design (used client-side). Cached per
// process; keyed to our environment (sandbox vs live).
let _stripePk: string | null = null;
export async function getStripePublishableKey(): Promise<string> {
  if (_stripePk) return _stripePk;
  const env = KEY.startsWith("sand_") ? "sandbox" : "live";
  const res = await fetch("https://payment-wrapper.liteapi.travel/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicKey: env }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`payment config ${res.status}`);
  const d = (await res.json()) as { publicKey?: string };
  _stripePk = d.publicKey ?? "";
  return _stripePk;
}

// ---- date helpers ----
function addDays(isoDate: string, n: number) {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function inDays(n: number) {
  return new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
}

// ---- core: static hotel content joined to live rates for a city + date range ----
async function fetchStays(opts: {
  target: SearchTarget;
  checkin: string;
  checkout: string;
  limit: number;
}): Promise<HotelStay[]> {
  const hotels =
    opts.target.kind === "radius"
      ? await listHotelsByRadius(opts.target.lat, opts.target.lng, opts.target.radius, opts.limit)
      : await listHotelsByCity(opts.target.city, opts.target.country, opts.limit);
  const byId = new Map(hotels.map((h) => [h.id, h]));
  const ids = hotels.map((h) => h.id);
  if (!ids.length) return [];

  const rates = await searchRates(ids, opts.checkin, opts.checkout);

  const items: HotelStay[] = [];
  for (const entry of rates) {
    const h = byId.get(entry.hotelId);
    const rt = entry.roomTypes?.[0];
    const firstRate = rt?.rates?.[0];
    if (!h || !rt || !firstRate) continue;
    const you = rt.offerRetailRate?.amount;
    if (typeof you !== "number") continue;
    const them = rt.suggestedSellingPrice?.amount ?? null;
    const refundable = (firstRate.cancellationPolicies?.refundableTag || "") !== "NRFN";
    const feeAtHotel = Math.round(
      (firstRate.retailRate?.taxesAndFees ?? [])
        .filter((t: any) => t?.included === false)
        .reduce((s: number, t: any) => s + (t.amount || 0), 0),
    );
    items.push({
      id: h.id,
      name: h.name,
      city: h.city || "",
      address: h.address || "",
      stars: Math.round(h.stars || h.starRating || 0),
      photo: h.main_photo || h.thumbnail || null,
      offerId: rt.offerId,
      you: memberPrice(you, them), // max(SSP - member discount, net + margin floor)
      them: them ? Math.round(them) : null,
      currency: rt.offerRetailRate?.currency || "USD",
      room: firstRate.name || "Standard room",
      board: firstRate.boardName || "Room only",
      freeCancel: refundable,
      feeAtHotel,
      rating: typeof h.rating === "number" ? h.rating : null,
      reviewCount: h.reviewCount || 0,
      lat: typeof h.latitude === "number" ? h.latitude : null,
      lng: typeof h.longitude === "number" ? h.longitude : null,
      categories: [],
    });
  }
  // Lead with the biggest price-beats.
  items.sort((a, b) => (b.them ? b.them - b.you : 0) - (a.them ? a.them - a.you : 0));
  tagCategories(items);
  return items;
}

// Tag each hotel with the categories it earns, relative to this result set.
function tagCategories(items: HotelStay[]) {
  if (!items.length) return;

  // price percentile (0 = cheapest, 1 = priciest)
  const byPrice = [...items].sort((a, b) => a.you - b.you);
  const priceRank = new Map<HotelStay, number>();
  byPrice.forEach((it, i) => priceRank.set(it, byPrice.length > 1 ? i / (byPrice.length - 1) : 0.5));

  // centrality: distance to the centroid of geolocated hotels
  const geo = items.filter((i) => i.lat != null && i.lng != null);
  const cLat = geo.length ? geo.reduce((s, i) => s + (i.lat as number), 0) / geo.length : null;
  const cLng = geo.length ? geo.reduce((s, i) => s + (i.lng as number), 0) / geo.length : null;
  const dist = (i: HotelStay) =>
    i.lat != null && i.lng != null && cLat != null
      ? Math.hypot(i.lat - cLat, i.lng - (cLng as number))
      : Infinity;
  const byDist = [...items].sort((a, b) => dist(a) - dist(b));
  const centralCut = byDist[Math.floor((byDist.length - 1) * 0.35)];
  const centralMax = centralCut ? dist(centralCut) : 0;

  for (const it of items) {
    const p = priceRank.get(it) ?? 0.5;
    const r = it.rating ?? 0;
    const tags: Category[] = [];
    if (p <= 0.35) tags.push("budget");
    if ((p >= 0.85 || it.stars >= 5) && r >= 9) tags.push("luxury");
    if (r >= 9 && it.reviewCount >= 500 && p > 0.2 && p < 0.85) tags.push("comfort");
    if (dist(it) <= centralMax && Number.isFinite(dist(it))) tags.push("convenience");
    it.categories = tags;
  }
}

// ---- user-driven booking search: destination + check-in + number of nights ----
export type SearchResult = {
  city: string;
  checkin: string;
  checkout: string;
  nights: number;
  items: HotelStay[];
};

export async function searchStays(input: {
  dest: string;
  checkin: string;
  nights: number;
}): Promise<SearchResult> {
  const target = resolveDest(input.dest);
  if (!target) throw new Error(`Unknown destination "${input.dest}"`);
  const nights = Math.max(1, Math.min(30, Math.round(input.nights)));
  const checkout = addDays(input.checkin, nights);
  const items = await fetchStays({ target, checkin: input.checkin, checkout, limit: 40 });
  return { city: target.name, checkin: input.checkin, checkout, nights, items: items.slice(0, 30) };
}

// ---- hotel detail: gallery + hotel facts + rich, bookable room options ----
export type RoomOption = {
  offerId: string;
  title: string; // cleaned room/rate name
  beds: string; // "1 King bed"
  size: string | null; // "18 m²"
  sleeps: number;
  board: string; // boardName, e.g. "Bed & Breakfast"
  breakfast: boolean; // does the board include breakfast
  freeCancel: boolean;
  mandatory: string | null; // human note about the fee due at the hotel
  fee: number; // numeric fee due at the hotel (0 if none/bundled)
  amenities: string[]; // top room amenities
  image: string | null; // room-matched photo
  you: number;
  them: number | null;
  currency: string;
};

export type ReviewSnippet = {
  name: string;
  country: string | null;
  type: string | null;
  headline: string;
  pros: string;
};

export type HotelDetail = {
  images: string[];
  facilities: string[];
  checkinTime: string | null;
  checkoutTime: string | null;
  reviews: ReviewSnippet[];
  options: RoomOption[];
};

const BED_WORDS = ["king", "queen", "double", "twin", "single", "bunk", "sofa", "murphy"];

function bedKeywords(s: string): Set<string> {
  const t = (s || "").toLowerCase();
  const found = BED_WORDS.filter((b) => t.includes(b));
  if (/wall bed|flex|murphy/.test(t)) found.push("murphy");
  return new Set(found);
}

function titleCase(s: string) {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function cleanRoomName(n: string) {
  // Supplier names cram fees/sizes after the room name using ",", "...", " - ",
  // "30USD MAND CHG", "160 SQ FT" etc. Cut at the first such marker.
  let s = (n || "").split(/,|\.\.\.| - |\d+\s?USD|MAND\s?CHG/i)[0].trim();
  s = s.replace(/\b\d+\s?(SQ\s?FT|SQFT|SQM|SQ\s?M)\b.*$/i, "").trim();
  return s ? titleCase(s) : "Room";
}

// Words that mean a candidate string actually describes a room (not a hotel name).
const ROOM_WORDS =
  /room|suite|studio|king|queen|double|twin|single|deluxe|standard|superior|apartment|villa|cabin|bed|loft/i;

// Produce a consistent, hotel-name-free room title. Suppliers are inconsistent:
// some rate names are the real room type ("Double Room"), some just echo the
// hotel name ("Aloft"), and catalog names carry the hotel as a prefix
// ("Aloft King Room"). Strip the hotel name everywhere; if nothing describing a
// room is left, synthesize one from the bed configuration.
function deriveRoomTitle(rateName: string, room: RoomInfo | null, hotelName: string): string {
  const hn = (hotelName || "").toLowerCase().trim();
  const stripHotel = (s: string) => {
    if (!hn) return s;
    const re = new RegExp(hn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig");
    return s.replace(re, "").replace(/\s{2,}/g, " ").trim();
  };
  for (const raw of [rateName, room?.roomName ?? ""]) {
    const c = stripHotel(cleanRoomName(raw));
    if (c && ROOM_WORDS.test(c)) return titleCase(c);
  }
  const beds = room?.beds || guessBeds(rateName);
  if (beds) {
    const primary = beds
      .split("·")[0]
      .replace(/^\s*\d+\s*/, "")
      .replace(/\bbeds?\b/i, "")
      .trim();
    if (primary) return titleCase(primary) + " Room";
  }
  return "Standard Room";
}

type RoomInfo = {
  roomName: string;
  beds: string;
  bedText: string;
  size: string | null;
  sleeps: number | null;
  amenities: string[];
  photos: string[];
};

// Supplier bed descriptions are verbose and sometimes self-contradictory
// ("Extra-large double bed (Super-king size)"). Collapse to a clean label,
// preferring the size named in parentheses when present.
function normalizeBed(raw: string): string {
  const s = (raw || "").toLowerCase();
  const paren = s.match(/\(([^)]*)\)/)?.[1] || "";
  const hay = paren + " " + s; // check the parenthetical size first
  const label =
    /super[-\s]?king|\bking\b/.test(hay) ? "King" :
    /\bqueen\b/.test(hay) ? "Queen" :
    /\bfull\b/.test(hay) ? "Full" :
    /\bdouble\b/.test(hay) ? "Double" :
    /\btwin\b/.test(hay) ? "Twin" :
    /\bsingle\b/.test(hay) ? "Single" :
    /sofa|pull[-\s]?out/.test(hay) ? "Sofa" :
    /bunk/.test(hay) ? "Bunk" :
    /murphy|wall bed/.test(hay) ? "Wall" :
    "";
  return label ? label + " bed" : titleCase(s.replace(/\([^)]*\)/g, "").trim()) || "Bed";
}

// Normalize the area unit so rooms don't mix "m²" and "sqm".
function normUnit(u: string): string {
  const s = (u || "").toLowerCase();
  if (/m2|sqm|sq\s?m|metre|meter/.test(s)) return "m²";
  if (/ft2|sqft|sq\s?ft|feet|foot/.test(s)) return "ft²";
  return u || "";
}

function buildRoomCatalog(detail: any): RoomInfo[] {
  return (detail?.rooms ?? []).map((rm: any): RoomInfo => {
    const bedTypes = rm?.bedTypes ?? [];
    const beds = bedTypes
      .map((b: any) => {
        const label = normalizeBed(b.bedType || "");
        return b.quantity > 1 ? `${b.quantity} ${label.replace(/bed$/, "beds")}` : label;
      })
      .join(" · ");
    return {
      roomName: rm?.roomName || "Room",
      beds,
      bedText: bedTypes.map((b: any) => b.bedType).join(" ") + " " + (rm?.roomName || ""),
      size: rm?.roomSizeSquare
        ? `${rm.roomSizeSquare} ${normUnit(rm.roomSizeUnit)}`.trim()
        : null,
      sleeps: rm?.maxOccupancy ?? null,
      amenities: (rm?.roomAmenities ?? []).map((a: any) => a?.name).filter(Boolean),
      photos: (rm?.photos ?? []).map((p: any) => p?.hd_url || p?.url).filter(Boolean),
    };
  });
}

function matchRoom(rateName: string, catalog: RoomInfo[]): RoomInfo | null {
  const rk = bedKeywords(rateName);
  const rateAccessible = /accessible|hearing|mobility/i.test(rateName);
  let best: RoomInfo | null = null;
  let bestScore = -Infinity;
  for (const room of catalog) {
    const rmk = bedKeywords(room.bedText);
    let score = 0;
    for (const k of rk) if (rmk.has(k)) score += 2;
    // penalise beds the rate never mentioned, so a plain king beats a king+bunk
    for (const k of rmk) if (!rk.has(k)) score -= 0.6;
    if (/accessible|hearing|mobility/i.test(room.roomName) && !rateAccessible) score -= 1.5;
    if (room.photos.length) score += 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = room;
    }
  }
  return bestScore > 0 ? best : null;
}

function guessBeds(rateName: string): string {
  const k = [...bedKeywords(rateName)];
  if (!k.length) return "";
  return k.map((w) => (w === "murphy" ? "Wall bed" : titleCase(w) + " bed")).join(" · ");
}

// Curate a compact gallery (~15): exterior first, then bed / bath / breakfast / pool.
const GALLERY_CATS = [
  /exterior|facade|building|entrance/i,
  /bed|room|suite|guest/i,
  /bath|shower|washroom/i,
  /breakfast|dining|restaurant|food/i,
  /pool|spa|sauna/i,
  /gym|fitness|bar|lounge|lobby|terrace|view/i,
];

function buildGallery(detail: any): string[] {
  const raw = (detail?.hotelImages ?? [])
    .map((im: any) => ({
      url: im?.urlHd || im?.url,
      cap: (im?.caption || "").toLowerCase(),
      order: typeof im?.order === "number" ? im.order : 999,
      def: !!im?.defaultImage,
    }))
    .filter((x: any) => x.url);

  const rank = (cap: string) => {
    const i = GALLERY_CATS.findIndex((rx) => rx.test(cap));
    return i === -1 ? GALLERY_CATS.length : i;
  };

  const exterior: string | undefined =
    detail?.main_photo ||
    raw.find((x: any) => GALLERY_CATS[0].test(x.cap))?.url ||
    raw.find((x: any) => x.def)?.url ||
    raw[0]?.url;

  const sorted = [...raw].sort(
    (a: any, b: any) => rank(a.cap) - rank(b.cap) || a.order - b.order,
  );

  const out: string[] = [];
  const push = (u?: string) => {
    if (u && !out.includes(u)) out.push(u);
  };
  push(exterior);
  for (const x of sorted) {
    if (out.length >= 15) break;
    push(x.url);
  }
  return out;
}

// Tidy supplier amenity/facility wording for guests.
function tidyLabel(s: string): string {
  return (s || "").replace(/communications?\s+accessible/i, "Accessible").trim();
}

const BREAKFAST_BOARDS = new Set(["BB", "HB", "FB", "AI"]);

// Pandemic-era health-protocol / packaging tags the supplier lists as
// "facilities". They read as noise (and "Breakfast takeaway containers" even
// gets mistaken for breakfast being served), so drop them outright.
const FACILITY_NOISE = [
  /takeaway container|individually[-\s]?wrapped|grab[-\s]?and[-\s]?go/i,
  /physical distanc|social distanc/i,
  /hand sanitiz|sanitis|sanitiz/i,
  /temperature (check|screen)|health screen/i,
  /protective screen|protective shield|sneeze guard/i,
  /face mask|face cover|ppe\b/i,
  /contactless|cashless/i,
];

const FACILITY_PRIORITY = [
  /parking/i,
  /^breakfast\b|breakfast (available|included|buffet|served|in the room)/i,
  /free wifi/i,
  /wifi/i,
  /pool/i,
  /fitness|gym/i,
  /restaurant/i,
  /\bbar\b/i,
  /spa/i,
  /pet/i,
  /air condition/i,
  /shuttle/i,
  /laundry/i,
  /reception|24-hour/i,
];

function pickFacilities(detail: any): string[] {
  const all: string[] = Array.from(new Set<string>(detail?.hotelFacilities ?? [])).filter(
    (f) => !FACILITY_NOISE.some((rx) => rx.test(f)),
  );
  const picked: string[] = [];
  for (const rx of FACILITY_PRIORITY) {
    const hit = all.find((f) => rx.test(f) && !picked.includes(f));
    if (hit) picked.push(hit);
  }
  for (const f of all) {
    if (picked.length >= 10) break;
    if (!picked.includes(f)) picked.push(f);
  }
  return [...new Set(picked.map(tidyLabel))].slice(0, 10);
}

// Non-Latin scripts: CJK, Hiragana/Katakana, Hangul, Cyrillic, Arabic, Thai, Hebrew.
const NON_LATIN =
  /[぀-ヿ㐀-䶿一-鿿가-힯Ѐ-ӿ؀-ۿ฀-๿֐-׿]/;

function isEnglishReview(rv: any): boolean {
  const text = `${rv?.headline || ""} ${rv?.pros || ""}`;
  if (NON_LATIN.test(text)) return false; // definitely not English
  const lang = String(rv?.language || "").toLowerCase();
  return lang === "" || lang === "en" || lang === "eng" || lang === "english";
}

export async function getHotelDetail(input: {
  hotelId: string;
  checkin: string;
  nights: number;
}): Promise<HotelDetail> {
  const nights = Math.max(1, Math.min(30, Math.round(input.nights)));
  const checkout = addDays(input.checkin, nights);

  const [detail, rates, rawReviews] = await Promise.all([
    hotelDetail(input.hotelId),
    searchRates([input.hotelId], input.checkin, checkout, 12),
    hotelReviews(input.hotelId),
  ]);

  const reviews: ReviewSnippet[] = rawReviews
    .filter((rv: any) => (rv?.pros || rv?.headline) && !/^\s*$/.test(rv?.pros || rv?.headline || ""))
    .filter(isEnglishReview) // English only for now; the language tag isn't reliable, so also gate on script
    .slice(0, 3)
    .map((rv: any) => ({
      name: rv.name || "Guest",
      country: rv.country || null,
      type: rv.type ? String(rv.type).replace(/_/g, " ") : null,
      headline: rv.headline || "",
      pros: rv.pros || "",
    }));

  const images = buildGallery(detail);
  const catalog = buildRoomCatalog(detail);
  const entry = rates[0];
  const seen = new Set<string>();

  // LiteAPI returns each rate PLAN as its own roomTypes[] entry (rates[] is
  // always length 1 — nothing nested to unwrap there), and the same physical
  // room commonly appears many times over: different providers, near-identical
  // prices, and — this is the useful part — different cancellation policies at
  // different prices (verified live: e.g. the same king room both non-refundable
  // and refundable a few dollars more). Group by physical room (bed config +
  // board + accessibility) and keep only the cheapest non-refundable and
  // cheapest refundable candidate per group, so the guest sees an actual
  // refundable-vs-not price choice instead of a wall of near-duplicates.
  type Candidate = RoomOption & { groupKey: string };
  const candidates: Candidate[] = (entry?.roomTypes ?? [])
    .map((rt: any): Candidate | null => {
      const fr = rt?.rates?.[0];
      const you = rt?.offerRetailRate?.amount;
      if (!rt?.offerId || !fr || typeof you !== "number") return null;

      const room = matchRoom(fr.name || "", catalog);
      const boardType = fr.boardType || "RO";
      const board = fr.boardName || "Room only";
      const fees = (fr.retailRate?.taxesAndFees ?? []).filter((t: any) => t?.included === false);
      const feeSum = Math.round(fees.reduce((s: number, t: any) => s + (t.amount || 0), 0));
      // Supplier fee descriptions ("Heritage charge" etc.) confuse guests; show the
      // amount and that it's collected at the hotel, without the raw jargon.
      const mandatory = feeSum ? `+ $${feeSum} resort/facility fee due at the hotel` : null;
      const beds = [...bedKeywords(fr.name || "")].sort().join("+") || "unknown";
      const accessible = /accessible|hearing|mobility/i.test(fr.name || "") ? "acc" : "std";

      return {
        offerId: rt.offerId,
        title: deriveRoomTitle(fr.name || "", room, detail?.name || ""),
        beds: room?.beds || guessBeds(fr.name || ""),
        size: room?.size ?? null,
        sleeps: fr.maxOccupancy || room?.sleeps || 2,
        board,
        breakfast: BREAKFAST_BOARDS.has(boardType) || /breakfast/i.test(board),
        freeCancel: (fr.cancellationPolicies?.refundableTag || "") !== "NRFN",
        mandatory,
        fee: feeSum,
        amenities: [...new Set((room?.amenities ?? []).map(tidyLabel))].slice(0, 5),
        image: room?.photos?.[0] ?? images[0] ?? null,
        you: memberPrice(you, rt.suggestedSellingPrice?.amount ?? null), // max(SSP - discount, net + margin floor)
        them: rt.suggestedSellingPrice?.amount ? Math.round(rt.suggestedSellingPrice.amount) : null,
        currency: rt.offerRetailRate?.currency || "USD",
        groupKey: `${beds}|${board}|${accessible}`,
      };
    })
    .filter((o: Candidate | null): o is Candidate => !!o);

  // Per physical-room group, keep the cheapest non-refundable and cheapest
  // refundable candidate (at most 2 entries per group).
  const byGroup = new Map<string, { nrfn?: Candidate; rfn?: Candidate }>();
  for (const c of candidates) {
    const slot = byGroup.get(c.groupKey) ?? {};
    const bucket = c.freeCancel ? "rfn" : "nrfn";
    if (!slot[bucket] || c.you < slot[bucket]!.you) slot[bucket] = c;
    byGroup.set(c.groupKey, slot);
  }

  const options: RoomOption[] = [...byGroup.values()]
    .flatMap((slot) => {
      // Use one consistent title/image/beds for both cancellation variants of
      // the same room, from whichever is cheaper, so they read as one room
      // with two price choices rather than two different-looking rooms.
      const base = (slot.nrfn ?? slot.rfn)!;
      const pick = (c: Candidate | undefined): RoomOption | null =>
        c ? { ...c, title: base.title, image: base.image, beds: base.beds, sleeps: base.sleeps } : null;
      return [pick(slot.nrfn), pick(slot.rfn)].filter((o): o is RoomOption => !!o);
    })
    .filter((o: RoomOption) => {
      const k = o.title + "|" + o.board + "|" + o.you;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a: RoomOption, b: RoomOption) => a.you - b.you)
    .slice(0, 8);

  return {
    images,
    facilities: pickFacilities(detail),
    checkinTime: detail?.checkinCheckoutTimes?.checkin_start ?? null,
    checkoutTime: detail?.checkinCheckoutTimes?.checkout ?? null,
    reviews,
    options,
  };
}

// ---- curated inspiration rows for the default (unsearched) landing ----
export async function getCollection(spec: {
  key: string;
  title: string;
  blurb: string;
  destKey: string;
}): Promise<Collection> {
  const dest = DEST_BY_KEY.get(spec.destKey);
  if (!dest) return { key: spec.key, title: spec.title, blurb: spec.blurb, city: "", items: [] };
  const checkin = inDays(30);
  const items = await fetchStays({
    target: { kind: "radius", name: dest.name, lat: dest.lat, lng: dest.lng, radius: dest.radius },
    checkin,
    checkout: addDays(checkin, 2),
    limit: 24,
  });
  return { key: spec.key, title: spec.title, blurb: spec.blurb, city: dest.name, items: items.slice(0, 8) };
}

// A representative photo for a destination — the first decent hotel exterior in
// its perimeter. Static (no rates), used once to bake the seasonal image map.
export async function getDestinationImage(destKey: string): Promise<string | null> {
  const dest = DEST_BY_KEY.get(destKey);
  if (!dest) return null;
  const hotels = await listHotelsByRadius(dest.lat, dest.lng, dest.radius, 12);
  for (const h of hotels) {
    const photo = h.main_photo || h.thumbnail;
    if (photo) return photo as string;
  }
  return null;
}
