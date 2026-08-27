// Server-only LiteAPI client. The key lives here and never reaches the browser.
// Field paths below were verified against the live sandbox (see probe results):
//   search:  data[].roomTypes[].offerId / .offerRetailRate.amount / .suggestedSellingPrice.amount
//   prebook: data.prebookId / .price / .priceDifferencePercent / .cancellationChanged

import "server-only";
import { DEST_BY_KEY } from "./destinations";
import { US_CITY_SET } from "./us-cities";
import { INTL_CITY_BY_DEST } from "./intl-cities";
import { buildCancelPolicy, describeTiers, zoneFor } from "./cancellation";
import {
  marginFor,
  displayPrice,
  compareAtPrice,
  type RateEvidence,
} from "./pricing";
import { summarizeFees, type TaxSchemaEntry } from "./fees";

const BASE = process.env.LITEAPI_BASE_URL || "https://api.liteapi.travel/v3.0";
const KEY = process.env.LITEAPI_KEY || "";

type Json = Record<string, unknown> | unknown[];

const RATE_LIMIT_ATTEMPTS = 3;
const RATE_LIMIT_BACKOFF_MS = 400;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api(
  method: string,
  path: string,
  opts: { body?: unknown; params?: Record<string, string | number> } = {},
  attempt = 1,
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

  // 429 is a throughput limit, not a failure of this request. Sandbox allows
  // ~5 requests/second (production is 27k/minute), and one search page can
  // legitimately fire several calls back to back — the detail page's retry
  // loop and the thin-market fill-in round both add pressure. Measured
  // 2026-08-23 (analysis/2026-08-23/zero_items.mts): eight rapid area searches
  // produced one 4290 "exceeded the allowed request limit", which surfaced to
  // the guest as an empty result set indistinguishable from "nowhere to stay".
  // Back off and ask again rather than reporting a lie.
  if (res.status === 429 && attempt < RATE_LIMIT_ATTEMPTS) {
    await sleep(RATE_LIMIT_BACKOFF_MS * attempt);
    return api(method, path, opts, attempt + 1);
  }

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
  // Tax and fees the SUPPLIER has already baked into `you`, for the whole stay.
  // Without this, `you` is uncomparable across hotels: some suppliers quote a
  // tax-inclusive rate and some leave the tax for the property, so the same
  // number silently means two different things (measured in Austin: Sonesta's
  // $353 includes its tax, Town Lake's $368 does not and $59 follows at the
  // desk). Carrying it lets the card show one honest base rate everywhere.
  //
  // The amount is the supplier's own disclosed figure and does NOT move with
  // our margin — verified across margins 0/10/20/30, it held at 56.43 while
  // the total rose from 343.34 to 446.34. So `you - taxInRate` is the room
  // line, and our markup on the tax portion sits inside it rather than
  // inflating a tax we do not collect.
  taxInRate: number;
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

/**
 * How many hotelIds we ask for, and therefore how many we price in the one
 * /hotels/rates call. Swept live on Austin, 2026-08-23, every call on a unique
 * check-in date so LiteAPI's response cache could not answer it
 * (analysis/2026-08-23/area_scaling.mts and area_scaling_deep.mts):
 *
 *   ids sent   latency   hotels with rates   payload
 *      30       4.65s        29  (97%)        0.6 MB
 *      60       4.58s        56  (93%)        0.4 MB
 *     100       5.34s        97  (97%)        0.8 MB
 *     200       5.63s       182  (91%)        1.6 MB
 *     300       5.19s       270  (90%)        2.3 MB
 *     400       5.94s       296  (74%)        2.5 MB
 *     500       5.30s       299  (60%)        2.5 MB
 *    1000       5.39s       306  (31%)        2.5 MB
 *
 * Two things decide the number. **Latency is flat**: it is the `timeout: 5`
 * supplier fan-out, not the hotel count, so 30 hotels cost within ~0.5s of 300.
 * The old cap of 30 was buying nothing. And **the response has its own ceiling
 * around 300 hotels** no matter how many ids are sent, so anything past ~300 is
 * ids we pay to send and never hear back about.
 *
 * 300 sits at that ceiling with almost no waste. Raise it only if LiteAPI's own
 * cap moves; re-run the sweep before changing it.
 */
export const HOTEL_LIMIT = 300;

/**
 * The widest circle "search this area" will ask for. NOT a LiteAPI limit: the
 * same sweep found /data/hotels answers a 200 km radius in 0.37s. It is a
 * product limit — beyond about 100 km "this area" stops meaning anything, and
 * the hotel list is saturated well before it (Austin returns the full 1000-row
 * page at 15 km already). A viewport wider than this is searched from its
 * centre and the map says so.
 */
export const AREA_MAX_RADIUS_M = 100_000;

async function listHotelsByRadius(lat: number, lng: number, radius: number, limit = HOTEL_LIMIT) {
  const d = await api("GET", "/data/hotels", {
    params: { latitude: lat, longitude: lng, radius, limit },
  });
  return (d.data ?? d) as any[];
}

async function listHotelsByCity(cityName: string, countryCode: string, limit = HOTEL_LIMIT) {
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

// `margin` is explicit and required at every call site, never defaulted. Two
// values are meaningful:
//   0            the BASELINE call. The only request whose suggestedSellingPrice
//                is real; also the only place true net cost is visible.
//   MARGIN_PCT   the PRICED call. offerRetailRate is what the guest is charged
//                and offerId is what we may book. Its SSP is garbage — see
//                pricing.ts — so never read suggestedSellingPrice from here.
async function searchRates(
  hotelIds: string[],
  checkin: string,
  checkout: string,
  maxRatesPerHotel: number,
  margin: number,
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
      // Server-side deduplication of the supplier fan-out. One hotelId is not
      // one inventory: LiteAPI queries many wholesalers live, each holding its
      // own contract for the same physical rooms and naming them differently.
      // With this on, every rate carries `mappedRoomId` — the physical room —
      // and the near-duplicate plans collapse. Measured: 5000 plans -> 135,
      // 17.2 MB -> 0.5 MB, identical cheapest price, no extra latency.
      roomMapping: true,
      // How long LiteAPI waits for its SUPPLIERS. Swept cold on 4 hotels,
      // 2026-08-20 (analysis/2026-08-20/timeout_cold.py) — every call on a
      // unique date, because LiteAPI caches a response for identical params and
      // an earlier sweep measured that cache instead of the API:
      //
      //   timeout   median      plans   rooms
      //   default     3.96s        35      20
      //   2           2.47s        37      19
      //   4           3.67s        57      39
      //   5           4.77s        66      42   <- peak inventory
      //   6           5.68s        64      40
      //   8           7.73s        64      34
      //   10          9.54s        51      29
      //   30         10.45s        46      28
      //
      // Two readings decide this. Latency tracks the timeout almost 1:1, so it
      // is a fixed WAIT, not a ceiling on a usually-faster call — every extra
      // second is paid in full on every request. And inventory peaks at 5s and
      // then decays, so the seconds past it buy nothing. 30 was costing ~6s per
      // call for FEWER rooms than 5 returns.
      //
      // `maxRatesPerHotel` is free by comparison: 3.97-4.65s across caps 40 to
      // 800 at timeout 5, all of it the timeout. So depth stays, the wait goes.
      timeout: 5,
      // Our entire revenue. LiteAPI marks the net rate up by this percentage
      // server-side, charges the guest the marked-up amount, and pays us the
      // difference. Omitting it (or letting an account-level default apply)
      // means offerRetailRate comes back at net and we earn nothing. It must
      // never reach the browser: see the HotelStay mapping below.
      margin,
    },
  });
  return (d.data ?? d) as any[];
}

/**
 * One hotel's rates, retried while the response comes back EMPTY.
 *
 * /hotels/rates is not deterministic. Measured 2026-08-23 on Chicken Ranch
 * Casino Resort (lp657d352a), Sep 20-22, identical body every time
 * (analysis/2026-08-23/yosemite_probe2.mts): 8 of 24 calls returned zero
 * roomTypes and the other 16 returned the same 3 plans. The hotel plainly has
 * inventory; LiteAPI just sometimes answers as though it does not, which the
 * detail page renders as "This hotel has no priced availability for those
 * dates" — a false statement to the guest, and the one being investigated.
 *
 * It is NOT a timeout. The sweep held `timeout` at 5, 10 and 20 and every
 * single response, empty or full, came back in ~1.2s. Nothing is running out
 * of time, so raising the wait cannot help and only costs latency. Empty rates:
 *
 *   timeout  5   ->  2/8 empty
 *   timeout 10   ->  2/8 empty
 *   timeout 20   ->  4/8 empty
 *
 * It is also hotel-specific, not global, so this is one supplier misbehaving
 * rather than the endpoint being unreliable everywhere. 30 calls each
 * (analysis/2026-08-23/empty_rate.mts):
 *
 *   lp657d352a  Chicken Ranch   9/30 empty   p = 0.30
 *   lp6556f7f5  Gateway Hotel   0/30 empty   p = 0.00
 *
 * So the fix is to ask again. Sizing at p = 0.30, per call:
 *
 *   attempts   false sold-out   worst-case added latency
 *      1           30.0%              0.0s
 *      2            9.0%              1.2s
 *      3            2.7%              2.4s
 *      4            0.8%              3.6s
 *
 * Four. The detail page makes two of these calls that flap independently, so
 * per-call 2.7% is still a ~5% chance of a wrongly blank page (observed: 1 bad
 * render in 12 at three attempts); 0.8% each puts the page at ~1.6%. The
 * latency column is worst case and only reached on a hotel that is failing
 * anyway. Expected added latency is p/(1-p) x 1.2s, about half a second, and
 * exactly zero on the 70% of calls that answer first time.
 *
 * DETAIL PAGE ONLY, deliberately. In a multi-hotel search an empty entry means
 * "this one has no inventory", which is ordinary and expected; re-running a
 * 300-hotel call because some subset was quiet would be very expensive for very
 * little. Here the request is one hotel, and empty means the page is broken.
 */
const DETAIL_RATE_ATTEMPTS = 4;

async function searchRatesForDetail(
  hotelId: string,
  checkin: string,
  checkout: string,
  cap: number,
  margin: number,
) {
  let rows: any[] = [];
  for (let attempt = 1; attempt <= DETAIL_RATE_ATTEMPTS; attempt++) {
    rows = await searchRates([hotelId], checkin, checkout, cap, margin);
    if ((rows[0]?.roomTypes ?? []).length > 0) return rows;
  }
  // Genuinely nothing after every attempt. Now "no availability" is honest.
  return rows;
}

// The property's own filed levies — not a supplier's description of them. Used
// to name an ambiguous fee line correctly; see the long note in fees.ts about
// the $40 that one supplier files under "Taxes and Fees" and another under
// "Destination charge". Static data (lastUpdated runs weeks behind), so a
// failure here is non-fatal: fees simply fall back to the supplier's wording.
async function hotelTaxSchema(hotelId: string): Promise<TaxSchemaEntry[] | null> {
  try {
    const d = await api("GET", `/data/hotel/${encodeURIComponent(hotelId)}/tax-schema`);
    return ((d as any)?.data?.taxes ?? null) as TaxSchemaEntry[] | null;
  } catch {
    return null;
  }
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
// We ONLY ever operate as a commission partner: LiteAPI is the merchant of
// record, the guest's card is charged by them, and we're paid commission. The
// alternative (ACC_CREDIT_CARD / WALLET) would make US the merchant, charging
// our own card for the room and leaving us to collect from the guest and carry
// fraud/chargeback liability. We are deliberately not equipped for that, so
// those methods must never be reachable from this codebase.
//
// usePaymentSdk=true is what produces the `secretKey` + `transactionId` for the
// browser card session, so it is always on and not a caller's choice.
export async function prebook(offerId: string) {
  const d = await api("POST", "/rates/prebook", {
    body: { offerId, usePaymentSdk: true },
  });
  return (d as any).data ?? d;
}

// Finalize against the guest's completed card charge. `transactionId` is
// REQUIRED: without it there is no guest payment to book against, and the only
// other methods LiteAPI accepts would bill our own account instead. Failing
// loudly here is the point — a booking we can't tie to a guest charge must not
// proceed.
export async function book(input: {
  prebookId: string;
  firstName: string;
  lastName: string;
  email: string;
  transactionId: string;
}) {
  if (!input.transactionId) {
    throw new Error(
      "Refusing to book without a guest payment transactionId (would bill our own account)",
    );
  }
  const payment = { method: "TRANSACTION_ID", transactionId: input.transactionId };
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
  /**
   * Decides WHICH OF THE TWO PRICES we ask LiteAPI to charge (pricing.ts).
   * Costs no extra request: the session is known before the priced call is
   * made, so it only changes the `margin` value in a call we already send.
   * Defaults to false, i.e. the public rate, because being wrong in the
   * guest's disfavour is recoverable and the reverse is a revenue leak.
   */
  isMember?: boolean;
}): Promise<HotelStay[]> {
  const hotels =
    opts.target.kind === "radius"
      ? await listHotelsByRadius(opts.target.lat, opts.target.lng, opts.target.radius, opts.limit)
      : await listHotelsByCity(opts.target.city, opts.target.country, opts.limit);
  const byId = new Map(hotels.map((h) => [h.id, h]));
  const ids = hotels.map((h) => h.id);
  if (!ids.length) return [];

  // ONE call, at margin 0. This is the only request whose suggestedSellingPrice
  // is real and the only one exposing true net cost, and both are what the
  // margin decision needs. Its offerIds are priced at net and must NEVER be
  // booked or shown — a bookable offer is fetched per hotel at book intent,
  // carrying that hotel's own margin. See pricing.ts.
  //
  // Cap 40, not 1. A single plan is a sample of one, and the cheapest plan is
  // the likeliest to be an opaque rate with a placeholder SSP — so pricing the
  // hotel off it discards whatever real market evidence its other rooms carry
  // (median 4 sourced plans per hotel). Measured on 38 live hotels, the deeper
  // pull was not slower: 5.0s at cap 40 vs 11.7s at cap 1, because latency
  // here is supplier fan-out, not payload.
  let rates = await searchRates(ids, opts.checkin, opts.checkout, 40, 0);

  // The same nondeterministic empty response that breaks the detail page (see
  // searchRatesForDetail) also silently drops hotels from SEARCH. Measured on a
  // fixed Jamestown viewport, 10 identical area searches: Chicken Ranch was
  // priced in 6 and simply absent from 4 (analysis/2026-08-23/map_flap.mts).
  // That is a hotel appearing and disappearing between refreshes of the same
  // map view.
  //
  // Re-asking for the missing ids fixes it, but only pays in a THIN market
  // (analysis/2026-08-23/fillin_cost.mts):
  //
  //   Jamestown   48 ids ->  17 priced, 31 missing | round2 1.5s, rescued 1  (+6%)
  //   Austin     300 ids -> 197 priced, 103 missing | round2 4.1s, rescued 2  (+1%)
  //   Yosemite   141 ids ->  10 priced, 131 missing | round2 0.4s, rescued 0  (+0%)
  //
  // Most missing hotels are genuinely sold out and stay missing however often
  // we ask, so a blanket second round buys ~1% for seconds. But when round one
  // came back thin, one rescued hotel is a large share of the page and the
  // missing-set call is cheap. So: fill in only below the floor.
  const THIN_RESULT_FLOOR = 40;
  const priced = new Set(
    rates.filter((r: any) => (r?.roomTypes ?? []).length > 0).map((r: any) => r.hotelId),
  );
  if (priced.size < THIN_RESULT_FLOOR) {
    const missing = ids.filter((id) => !priced.has(id));
    if (missing.length) {
      const second = await searchRates(missing, opts.checkin, opts.checkout, 40, 0);
      rates = rates.concat(second.filter((r: any) => (r?.roomTypes ?? []).length > 0));
    }
  }

  const items: HotelStay[] = [];
  for (const entry of rates) {
    const h = byId.get(entry.hotelId);
    if (!h) continue;

    // Package rates are excluded from the room-only flow (see getHotelDetail),
    // so they must not inform the price shown on the card either.
    const roomTypes = (entry.roomTypes ?? []).filter((rt: any) => rt?.rateType !== "package");

    // Every plan we saw, as pricing evidence. Plans without a sourced SSP are
    // not counted against the hotel — they simply carry no parity constraint.
    const evidence: RateEvidence[] = [];
    for (const rt of roomTypes) {
      const n = rt?.offerRetailRate?.amount;
      if (typeof n !== "number") continue;
      evidence.push({
        net: n,
        ssp: rt?.suggestedSellingPrice?.amount ?? null,
        source: rt?.suggestedSellingPrice?.source ?? null,
      });
    }
    if (!evidence.length) continue;

    // The cheapest plan is what the card advertises — cheapest by what the
    // guest actually pays, rate plus property-collected charges. LiteAPI sorts
    // by rate alone, which picks the wrong plan whenever suppliers differ on
    // whether tax sits inside the rate (measured: a $764.25 rate excluding
    // $99.35 tax loses to a $773.81 rate that includes it).
    const stayCost = (rt: any) => {
      const n = rt?.offerRetailRate?.amount;
      if (typeof n !== "number") return Infinity;
      return n + summarizeFees(rt?.rates?.[0]?.retailRate?.taxesAndFees).dueAtPropertyTotal;
    };
    const cheapest = roomTypes.reduce(
      (best: any, rt: any) => (!best || stayCost(rt) < stayCost(best) ? rt : best),
      null as any,
    );
    const firstRate = cheapest?.rates?.[0];
    if (!cheapest || !firstRate || !Number.isFinite(stayCost(cheapest))) continue;

    // TRUE net cost — margin 0. Never displayed, never sent to the browser.
    const net = cheapest.offerRetailRate.amount;
    // Always a number now: a hotel is not unsellable just because we cannot
    // prove a saving on it. SSP only caps this. See the long note in pricing.ts.
    const margin = marginFor(evidence, { isMember: opts.isMember });
    const you = displayPrice(net, margin);
    // Null unless real sourced evidence exists AND we actually come in under
    // it — so a hotel with no public rate simply shows a price, no strikethrough.
    const them = compareAtPrice(you, evidence);

    const refundable = (firstRate.cancellationPolicies?.refundableTag || "") !== "NRFN";
    // Amounts already cover the whole stay; fees.ts must not re-multiply.
    const { dueAtPropertyTotal } = summarizeFees(firstRate.retailRate?.taxesAndFees);
    // The other half of the same array: what the supplier says is ALREADY in
    // the rate. Summed verbatim, for the same reason — LiteAPI has already
    // spread any per-night amount across the stay.
    const taxInRate = (firstRate.retailRate?.taxesAndFees ?? [])
      .filter((f: any) => f?.included === true && (f.amount ?? 0) > 0)
      .reduce((s: number, f: any) => s + f.amount, 0);

    items.push({
      id: h.id,
      name: h.name,
      city: h.city || "",
      address: h.address || "",
      stars: Math.round(h.stars || h.starRating || 0),
      photo: h.main_photo || h.thumbnail || null,
      offerId: cheapest.offerId,
      you,
      them: them === null ? null : Math.round(them),
      currency: cheapest.offerRetailRate?.currency || "USD",
      room: firstRate.name || "Standard room",
      board: firstRate.boardName || "Room only",
      freeCancel: refundable,
      feeAtHotel: Math.round(dueAtPropertyTotal),
      taxInRate: Math.round(taxInRate),
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
  notes?: string;
  isMember?: boolean;
}): Promise<SearchResult> {
  const target = resolveDest(input.dest);
  if (!target) throw new Error(`Unknown destination "${input.dest}"`);
  const nights = Math.max(1, Math.min(30, Math.round(input.nights)));
  const checkout = addDays(input.checkin, nights);
  const items = await fetchStays({
    target,
    checkin: input.checkin,
    checkout,
    limit: HOTEL_LIMIT,
    isMember: input.isMember,
  });
  if (input.notes) applyPreferenceBoost(items, input.notes);
  // No truncation. There used to be a `.slice(0, 30)` here and it was throwing
  // away ~90% of a result set that cost the same to fetch (see HOTEL_LIMIT).
  // The list view reveals these in pages; the map pins all of them.
  return { city: target.name, checkin: input.checkin, checkout, nights, items };
}

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "with", "for", "near", "close", "to", "in", "on", "of", "is",
  "are", "looking", "want", "need", "prefer", "like", "room", "rooms", "hotel", "stay", "place",
  "would", "please", "some", "any", "but", "not", "very",
]);

function keywordsFrom(text: string): string[] {
  return Array.from(
    new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOPWORDS.has(w))),
  );
}

export const CATEGORY_SYNONYMS: Record<Category, string[]> = {
  budget: ["budget", "cheap", "affordable", "inexpensive", "value"],
  luxury: ["luxury", "luxurious", "upscale", "highend", "fancy", "premium", "5star", "fivestar"],
  comfort: ["comfort", "comfortable", "cozy", "relaxing"],
  convenience: ["central", "downtown", "walkable", "convenient", "close", "nearby", "walking"],
};

// Light-touch relevance boost from the free-text "what are you looking for"
// field. Not real NLP — keyword overlap against our category tags plus each
// hotel's own name/room/board text — but enough to nudge a "quiet, near
// downtown" search toward the right handful without an LLM in the loop yet.
function applyPreferenceBoost(items: HotelStay[], notes: string) {
  const words = keywordsFrom(notes);
  if (!words.length) return;

  const score = (it: HotelStay) => {
    let s = 0;
    const haystack = `${it.name} ${it.room} ${it.board}`.toLowerCase();
    for (const w of words) {
      if (haystack.includes(w)) s += 1;
      for (const cat of it.categories) {
        if (CATEGORY_SYNONYMS[cat].some((syn) => syn.includes(w) || w.includes(syn))) s += 2;
      }
    }
    return s;
  };

  // Only reorders when a preference match actually differs; otherwise keeps
  // the existing price-beat ordering (stable on the original index).
  const scored = items.map((it, i) => ({ it, i, s: score(it) }));
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  items.splice(0, items.length, ...scored.map((x) => x.it));
}

// ---- map-driven search: whatever the visitor panned/zoomed the map to ----
// Same pricing/category pipeline as searchStays, just keyed off a live
// lat/lng/radius instead of a resolved destination.
export async function searchStaysInArea(input: {
  lat: number;
  lng: number;
  radius: number; // meters
  checkin: string;
  nights: number;
  isMember?: boolean;
}): Promise<{ items: HotelStay[]; radius: number; clamped: boolean }> {
  const nights = Math.max(1, Math.min(30, Math.round(input.nights)));
  const checkout = addDays(input.checkin, nights);
  const asked = Math.max(300, Math.round(input.radius));
  const radius = Math.min(AREA_MAX_RADIUS_M, asked);
  const items = await fetchStays({
    target: { kind: "radius", name: "This area", lat: input.lat, lng: input.lng, radius },
    checkin: input.checkin,
    checkout,
    limit: HOTEL_LIMIT,
    isMember: input.isMember,
  });
  // `clamped` is returned rather than swallowed. The map used to give up
  // silently on a viewport wider than 30 km, which read to the guest as "there
  // are no hotels here" when it meant "we declined to look". Now it searches
  // the centre and the map says that is what it did.
  return { items, radius, clamped: radius < asked };
}

// ---- hotel detail: gallery + hotel facts + rich, bookable room options ----
// One bookable commercial variant of a room: a board + cancellation combination
// at a price. This is the row a guest actually clicks.
export type RoomRate = {
  offerId: string;
  board: string; // the supplier's own boardName, e.g. "Bed & Breakfast"
  // What we DISPLAY and therefore promise. Differs from `board` only where a
  // hotel's breakfast passed the free-amenity gate while a supplier still filed
  // the rate as room-only; carried separately so the booking record can hold
  // both what we advertised and what the supplier contracted.
  boardLabel: string;
  breakfast: boolean; // does the board include breakfast
  freeCancel: boolean;
  freeCancelUntil: string | null; // "Sep 8", PROPERTY-LOCAL — see cancellation.ts
  // Same instant with time and zone: "Sep 7, 8:00 PM CDT". The short form fits
  // a chip; this is what a guest needs before relying on the deadline.
  freeCancelUntilLong: string | null;
  // The penalty ladder after the free window, already worded. Usually empty:
  // most rates either never refund or refund fully until one deadline. It is
  // non-empty exactly when a stay is PART-refundable for a while, which is
  // information in the guest's favour and was previously discarded.
  cancelTiers: string[];
  mandatory: string | null; // human note about the fee due at the hotel
  fee: number; // numeric fee due at the hotel (0 if none/bundled)
  sleeps: number;
  you: number;
  them: number | null;
  // What the stay ACTUALLY costs: `you` + `fee`. This is the only figure that
  // compares two plans fairly, because suppliers differ in whether tax is
  // inside the rate. Measured on one Asheville hotel, same dates: a $764.25
  // plan excluding $99.35 tax totals $863.60, while a $773.81 plan that bakes
  // tax in and excludes only a $40 fee totals $813.81. Ranking on the rate
  // alone puts the $49.79-more-expensive room first.
  total: number;
  currency: string;
};

// One PHYSICAL room, as LiteAPI's own room mapping identifies it — not a bucket
// we invented. `roomId` is `mappedRoomId`, the only field that reconciles the
// same room across the many wholesalers a single hotelId fans out to. Its rates
// are that room's commercial variants.
export type RoomOption = {
  roomId: string; // mappedRoomId (or a name-derived key if the supplier sent none)
  title: string; // cleaned room name
  beds: string; // "1 King bed"
  size: string | null; // "18 m²"
  sleeps: number;
  amenities: string[]; // top room amenities
  image: string | null; // room-matched photo
  // How many distinct supplier spellings collapsed into this one room. >1 means
  // the mapping did real cross-supplier reconciliation here (measured: 37% of
  // mapped rooms across 8 Asheville hotels).
  supplierNames: number;
  rates: RoomRate[]; // cheapest-first, one per board x cancellation combination
  from: number; // cheapest `total` among the rates
  currency: string;
};

export type ReviewSnippet = {
  name: string;
  country: string | null;
  type: string | null;
  headline: string;
  pros: string;
  // What the guest disliked. Shown alongside the praise: a page of nothing but
  // positives reads as marketing and tells a chooser nothing.
  cons: string;
  score: number | null;
  date: string | null;
};

// Room-independent identity — enough to render a hotel detail page's header
// and build a booking snapshot without depending on a search-result item
// (the detail page can be reached directly, not just from a search list).
export type HotelIdentity = {
  id: string;
  name: string;
  city: string;
  address: string;
  /** Full postal line, so the map has something to caption. */
  postcode: string | null;
  lat: number | null;
  lng: number | null;
  stars: number;
  photo: string | null;
  rating: number | null;
  reviewCount: number;
  currency: string;
};

// One theme LiteAPI's review model scores, with its own explanation.
export type SentimentCategory = { name: string; rating: number; note: string };

// A paragraph of the property's own description, with the sub-heading it sits
// under when the supplier wrote one.
export type DescriptionBlock = { heading: string | null; text: string };

// Practical facts a guest asks before booking and we already receive.
export type HotelFacts = {
  chain: string | null;
  phone: string | null;
  hotelType: string | null;
  parking: string | null; // "PAID" / "FREE" / null
  petsAllowed: boolean | null;
  childAllowed: boolean | null;
  airportCode: string | null;
  postcode: string | null;
};

// Travaxy's certified accessibility survey, reduced to what a guest can act on.
// `score` is the property's overall figure; `supported` names the needs the
// survey found provision for. Deliberately no rounding up: an unsupported need
// is simply absent from the list rather than shown as partial.
export type AccessibilitySummary = { score: number; supported: string[] } | null;

export type HotelDetail = {
  hotel: HotelIdentity;
  images: string[];
  facilities: string[];
  checkinTime: string | null;
  checkoutTime: string | null;
  reviews: ReviewSnippet[];
  // Everything below already arrives in the /data/hotel response we were
  // making anyway — it cost nothing to fetch and was being discarded.
  description: DescriptionBlock[];
  /** Age limits, deposits, ID requirements. Split into readable sentences. */
  importantInfo: string[];
  pros: string[];
  cons: string[];
  sentiment: SentimentCategory[];
  facts: HotelFacts;
  accessibility: AccessibilitySummary;
  /** Travaxy's certificate page. Linked, never embedded: it pulls external CSS. */
  accessibilityCertificate: string | null;
  reviewsTotal: number;
  /**
   * The property's FULL amenity list, deduped and tidied. `facilities` (the
   * short list) stays as the curated top-10 for the summary rail; this is what
   * the "all amenities" disclosure renders, since a guest looking for a
   * specific thing needs the whole list rather than our idea of the best ten.
   */
  allFacilities: string[];
  options: RoomOption[];
  // True when every surviving rate includes breakfast. Then it is a property
  // amenity, not a rate feature, and repeating the chip on all 14 rows says
  // nothing — the UI states it once instead.
  breakfastAllRates: boolean;
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

// Supplier shorthand, verbatim from live rate names ("STANDARD 2 QN
// MOBILITY/HEARING ACCESS RI SHWR"). Expanded rather than shown raw: it is the
// hotel's own room, and a guest should be able to read what it is.
const ABBREV: [RegExp, string][] = [
  [/\bqns?\b/gi, "Queen"],
  [/\bkg\b/gi, "King"],
  [/\bdbl\b/gi, "Double"],
  [/\bstd\b/gi, "Standard"],
  [/\bri\s+shwr\b/gi, "Roll-In Shower"],
  [/\bshwr\b/gi, "Shower"],
  [/\bcomm\b/gi, "Communication"],
  [/\baccess\b/gi, "Accessible"],
  [/\bmob\b/gi, "Mobility"],
  [/\bmtn\b/gi, "Mountain"],
  [/\bvw\b/gi, "View"],
  [/\bnonsmk\b/gi, "Non-Smoking"],
  [/\bw\/\s*/gi, "with "],
];

function expandAbbrev(s: string): string {
  return ABBREV.reduce((acc, [rx, to]) => acc.replace(rx, to), s).replace(/\s{2,}/g, " ").trim();
}

// Comma-separated tail segments that are a spec sheet, not a room description.
const SPEC_JUNK =
  /\d+\s?(sq\s?ft|sqft|sq\s?m|sqm)|mand\s?chg|\d+\s?usd|fire\s?al(arm|rm)|hdtv|mini\s?fridge|iron|hair\s?dryer|coffee|\btea\b|\bsafe\b|\bwifi?\b|\bphone\b|\bclock\b|\bdesk\b|microwave/i;

// Words that mean a segment actually describes a room (not a hotel name, not a
// list of in-room appliances).
const ROOM_WORDS =
  /room|suite|studio|king|queen|double|twin|single|deluxe|standard|superior|apartment|villa|cabin|bed|loft|view|accessib|mobility|hearing|balcon|terrace|smoking/i;

// Suppliers cram the room, its size, its fee and its entire amenity list into
// one comma-separated string. Keep the segments that describe the room and drop
// the rest, rather than cutting at the first comma — that truncation is what
// turned "Room, 1 King Bed, Mountain View" into a bare "Room".
function describeRoomName(raw: string): string {
  const segs = (raw || "")
    .split(/,|\.\.\.|\s+-\s+/)
    .map((x) => x.trim())
    .filter((x) => x && !SPEC_JUNK.test(x) && ROOM_WORDS.test(x))
    .slice(0, 3);
  const s = segs.join(", ").replace(/\s{2,}/g, " ").trim();
  return s ? titleCase(expandAbbrev(s)) : "";
}

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
    const c = describeRoomName(stripHotel(raw));
    if (c) return c;
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

// The whole amenity list, from the structured `facilities` array when present
// (49 typed entries on a hotel where `hotelFacilities` gives flat strings) and
// falling back to the strings otherwise. Same noise filter as the short list —
// pandemic-era "protective screen" entries are not amenities — but no priority
// cut, because this one exists to be complete.
function buildAllFacilities(detail: any): string[] {
  const structured = (detail?.facilities ?? [])
    .map((f: any) => (typeof f === "string" ? f : f?.name))
    .filter(Boolean) as string[];
  const flat = (detail?.hotelFacilities ?? []) as string[];
  const all = structured.length ? structured : flat;
  return [...new Set(all.filter((f) => !FACILITY_NOISE.some((rx) => rx.test(f))).map(tidyLabel))]
    .sort((a, b) => a.localeCompare(b));
}

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

// The description arrives as supplier HTML: <p><strong>Heading</strong></p>
// followed by <p>body</p>. Rendering it raw would put unsanitised supplier
// markup in the page, so it is parsed to text here and the heading structure is
// preserved rather than flattened into one wall of prose.
function parseDescription(html: string): DescriptionBlock[] {
  const chunks = (html || "")
    .split(/<\/p>/i)
    .map((c) => c.trim())
    .filter(Boolean);
  const out: DescriptionBlock[] = [];
  let pending: string | null = null;
  for (const chunk of chunks) {
    const text = chunk
      .replace(/<[^>]*>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&nbsp;/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
    if (!text) continue;
    // A paragraph that is entirely bold is a heading for what follows.
    const bold = /<strong[^>]*>[\s\S]*<\/strong>/i.test(chunk);
    const inner = chunk.replace(/<p[^>]*>/i, "").trim();
    if (bold && /^<strong/i.test(inner)) {
      pending = text;
      continue;
    }
    out.push({ heading: pending, text });
    pending = null;
  }
  if (pending) out.push({ heading: null, text: pending });
  return out.slice(0, 8);
}

// Suppliers run these sentences together without spaces ("...at the
// property.Guests are required..."), so the boundary has to be repaired before
// splitting or the result is one unreadable line.
function splitImportantInfo(raw: string): string[] {
  return (raw || "")
    .replace(/([.!?])([A-Z])/g, "$1 $2")
    .split(/\n+|(?<=[.!?])\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 12)
    .slice(0, 8);
}

const DISABILITY_LABELS: Record<string, string> = {
  manualWheelchair: "Manual wheelchair",
  electricWheelchair: "Electric wheelchair",
  wheelchairOrScooterImpaired: "Wheelchair or scooter",
  crouchesCaneImpaired: "Crutches or cane",
  elderlyImpaired: "Reduced mobility",
  hearingImpaired: "Hearing impaired",
  visuallyImpaired: "Visually impaired",
};

function buildAccessibility(detail: any): AccessibilitySummary {
  const acc = detail?.accessibility;
  const flags = acc?.disabilities;
  if (!acc || !flags) return null;
  const supported = Object.entries(flags)
    .filter(([, ok]) => ok === true)
    .map(([k]) => DISABILITY_LABELS[k] ?? k);
  const score = typeof acc.totalDisabilityScore === "number" ? acc.totalDisabilityScore : 0;
  if (!supported.length && !score) return null;
  return { score: Math.round(score), supported };
}

function buildSentiment(detail: any): SentimentCategory[] {
  return ((detail?.sentiment_analysis?.categories ?? []) as any[])
    .filter((c) => c?.name && typeof c.rating === "number")
    .map((c) => ({ name: c.name, rating: c.rating, note: c.description || "" }))
    .sort((a, b) => b.rating - a.rating);
}

function buildReviewSnippets(rawReviews: any[]): ReviewSnippet[] {
  return rawReviews
    .filter((rv: any) => (rv?.pros || rv?.headline) && !/^\s*$/.test(rv?.pros || rv?.headline || ""))
    .filter(isEnglishReview) // English only for now; the language tag isn't reliable, so also gate on script
    .slice(0, 5)
    .map((rv: any) => ({
      name: rv.name || "Guest",
      country: rv.country || null,
      type: rv.type ? String(rv.type).replace(/_/g, " ") : null,
      headline: rv.headline || "",
      pros: rv.pros || "",
      cons: rv.cons || "",
      score: typeof rv.averageScore === "number" ? rv.averageScore : null,
      date: typeof rv.date === "string" ? rv.date.slice(0, 10) : null,
    }));
}

// Amenity glyphs shown directly on a search-result tile (icon-only, no
// label text) — ordered by priority, since a tile only has room for a
// handful. Matched against the hotel's raw facility strings.
export const AMENITY_ICONS = [
  { key: "parking", rx: /parking/i },
  { key: "breakfast", rx: /breakfast/i },
  { key: "wifi", rx: /wifi/i },
  { key: "kitchenette", rx: /kitchenette|\bkitchen\b/i },
  { key: "microwave", rx: /microwave/i },
  { key: "fridge", rx: /refrigerator|\bfridge\b|mini[-\s]?bar/i },
  { key: "accessible", rx: /accessib|wheelchair/i },
  { key: "pool", rx: /\bpool\b/i },
  { key: "gym", rx: /fitness|\bgym\b/i },
  { key: "pet", rx: /\bpet\b/i },
  { key: "ac", rx: /air condition/i },
  { key: "spa", rx: /\bspa\b/i },
  { key: "restaurant", rx: /restaurant/i },
  { key: "bar", rx: /\bbar\b/i },
  { key: "laundry", rx: /laundry/i },
] as const;
export type AmenityKey = (typeof AMENITY_ICONS)[number]["key"];

function pickAmenityIcons(detail: any): AmenityKey[] {
  const facilities: string[] = detail?.hotelFacilities ?? [];
  const found: AmenityKey[] = [];
  for (const { key, rx } of AMENITY_ICONS) {
    if (found.length >= 6) break;
    if (facilities.some((f) => rx.test(f))) found.push(key);
  }
  return found;
}

// Photo gallery + amenity icons for a search-result card — the bulk
// /data/hotels listing behind fetchStays only returns one photo and no
// facility list per hotel, so a card fetches both together, once, lazily
// (rather than paying for every hotel's full detail on every search).
export async function getHotelCardExtras(
  hotelId: string,
): Promise<{ images: string[]; amenities: AmenityKey[] }> {
  const detail = await hotelDetail(hotelId);
  return { images: buildGallery(detail), amenities: pickAmenityIcons(detail) };
}

export type HotelPreview = {
  images: string[];
  amenities: AmenityKey[];
  facilities: string[];
  reviews: ReviewSnippet[];
  checkinTime: string | null;
  checkoutTime: string | null;
};

// Everything the preview modal shows beyond what the search-result item
// already carries (name/price/stars/rating) — deliberately skips rates
// (searchRates), since the preview doesn't select or book a room; that's
// what "Explore rooms" hands off to the full /stay page for.
export async function getHotelPreview(hotelId: string): Promise<HotelPreview> {
  const [detail, rawReviews] = await Promise.all([hotelDetail(hotelId), hotelReviews(hotelId)]);
  return {
    images: buildGallery(detail),
    amenities: pickAmenityIcons(detail),
    facilities: pickFacilities(detail),
    reviews: buildReviewSnippets(rawReviews),
    checkinTime: detail?.checkinCheckoutTimes?.checkin_start ?? null,
    checkoutTime: detail?.checkinCheckoutTimes?.checkout ?? null,
  };
}

// ---- room identity comes from LiteAPI, not from a catalog we invented ----
// The previous approach shipped ~10 hardcoded room types and asked
// POST /rooms/match to sort supplier names into them. It was the wrong shape of
// answer: our catalog could only ever describe the rooms we had thought of, and
// a semantic matcher forced every suite, bunk room and studio into "Standard
// Room, 1 King Bed" or into a catch-all we then had to invent client-side.
//
// `roomMapping: true` replaces it outright. LiteAPI resolves the supplier fan-
// out server-side and stamps every rate with `mappedRoomId` — the id of the
// PHYSICAL room, consistent across wholesalers that each name and price it
// differently. Measured 2026-08-19 on Hilton NOLA, same dates and cap:
//
//     roomMapping false -> 5000 plans, 17.2 MB, cheapest 340.22
//     roomMapping true  ->  135 plans,  0.5 MB, cheapest 340.22   (not slower)
//
// So the collapse costs no inventory and no price, and it needs no catalog: the
// rooms shown are the hotel's actual rooms.

// Within one mapped room the suppliers still disagree on wording, usually by
// tacking a spec sheet onto the same base name ("STANDARD 1 KING BED HEARING
// ACCESSIBLE" vs the same string plus ",VISUAL FIREALARM/DOOR/PHONE ALERT-MINI
// FRIDGE,351-371 SQ FT-HDTV..."). The shortest name that still describes a room
// is therefore the base product name, which is exactly what a guest should see.
// ---- breakfast: an amenity at some hotels, a product at others ----
// At a Holiday Inn Express the continental breakfast is served to every guest,
// so "Room Only" and "Breakfast Included" are two suppliers describing the same
// stay. Presenting them as a choice invents a decision the guest does not have,
// and doubles the row count for nothing.
//
// The property data cannot tell us which case we are in — measured on
// lp85c07, the ONLY breakfast entry in `hotelFacilities` is "Breakfast takeaway
// containers". The price gap can. Same mapped room, same cancellation terms,
// board the only difference:
//
//     RO 509.45 -> BI 512.03   +2.58     RO 557.04 -> BI 559.86   +2.82
//     RO 512.03 -> BI 517.21   +5.18     RO 559.86 -> BI 565.51   +5.65
//
// Two nights, two adults: about $1.30 per person per night. No hotel sells
// breakfast at that price — it is contract noise between two wholesalers, and
// the meal is free to everyone. A hotel that genuinely SELLS breakfast prices
// it far above this floor, and there both rows survive so the guest chooses.
const BREAKFAST_FLOOR_PER_PERSON_NIGHT = 8;

// The smallest refund premium worth presenting as a real choice. Below this,
// a guest is being asked to give up cancellation rights to save pocket change
// — Sainatha flagged a live case where free cancellation cost $2 more on a
// $601 room and $665 room. Nobody rationally picks non-refundable to save $2,
// so showing both rows as if it were a decision just adds clutter and makes
// non-refundable look like the "normal" price. Below the floor, only the
// refundable rate is shown. Flat, not per-night: the guest's actual question
// is "is this worth it", and a $2 gap is not, whether the stay is one night
// or ten.
const REFUND_PREMIUM_FLOOR = 20;

// ONE axis of choice per room: refundable or not. Nothing else.
//
// We sell a room, not a menu. Board is a property of whichever plan wins, never
// a second dimension crossed with cancellation — crossing them produced rows
// like "Room Only / Non-refundable $463" beside "Breakfast / Free cancellation
// $465", which asks the guest to price two unrelated things against each other
// in one comparison. So each room yields at most two rates.
//
// Within a cancellation bucket the winner is the cheapest plan, with one
// exception: if a breakfast plan costs less than the floor more, it wins
// instead. That is the "assume breakfast is included" rule — where the meal is
// not really being sold (measured at $1.30 per person per night, see above),
// take it; where a hotel genuinely charges for it, the cheaper room-only plan
// wins and we simply do not sell breakfast as an upsell.

// Two plans that only differ in cancellation terms are typically filed by the
// same wholesaler under the same rate name ("Standard 2 Queen Beds" /
// "Standard 2 Queen Beds Non Refundable") — see analysis/pricing-observations.md,
// where `name|board|refundableTag` paired 34 of 50 plans across a margin
// change. Stripping the cancellation wording turns that into a pairing key
// for cancellation terms instead, so a refundable rate can be matched back to
// the specific non-refundable rate it's a variant of.
type Plan = { rt: any; fr: any; name: string };

function rateFamilyKey(fr: any): string {
  const name = (fr?.name || "")
    .toLowerCase()
    .replace(/\bnon[\s-]?refundable\b|\brefundable\b/gi, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const board = (fr?.boardType || "RO").toLowerCase();
  return `${name}|${board}`;
}

// `rows[i]` is `plans[i]` already priced and fee-summarized — zipped rather
// than carrying the raw plan fields on RoomRate, since nothing past this
// function needs them. `plans` is null when called on rates that have
// already been through this once (mergeIdenticalRooms, below) and no raw
// plan data survives — same-family pairing is skipped in that case, same as
// before this function knew about rate families at all.
function pickPerCancellation(rows: RoomRate[], plans: Plan[] | null, nights: number): RoomRate[] {
  // Deliberately generous: anything under this is treated as "not really being
  // sold", so we err toward taking the better product rather than toward
  // charging for a free amenity. Occupancy is fixed at 2 adults in this client.
  const floor = BREAKFAST_FLOOR_PER_PERSON_NIGHT * 2 * Math.max(1, nights);
  const paired = rows.map((row, i) => ({ row, plan: plans ? plans[i] : null }));

  function bestOf(bucket: { row: RoomRate; plan: Plan | null }[]) {
    const cheapest = bucket.reduce((a, b) => (a.row.total <= b.row.total ? a : b));
    const withBf = bucket.filter((x) => x.row.breakfast);
    const cheapBf = withBf.length ? withBf.reduce((a, b) => (a.row.total <= b.row.total ? a : b)) : null;
    return cheapBf && cheapBf.row.total - cheapest.row.total <= floor ? cheapBf : cheapest;
  }

  const nonRefundable = paired.filter((x) => !x.row.freeCancel);
  const refundable = paired.filter((x) => x.row.freeCancel);

  const out: RoomRate[] = [];
  if (nonRefundable.length) {
    const chosen = bestOf(nonRefundable);
    out.push(chosen.row);
    if (refundable.length) {
      // Prefer the refundable variant of the SAME rate plan over whichever
      // refundable plan from any wholesaler happens to be cheapest — two
      // unrelated wholesalers' prices produce a "refund premium" that has
      // nothing to do with what flexibility actually costs. Fall back to
      // cheapest-anywhere when no sibling exists (or no plan data is
      // available to pair with), so a room never loses its only refundable
      // option.
      let pool = refundable;
      if (chosen.plan) {
        const key = rateFamilyKey(chosen.plan.fr);
        const sameFamily = refundable.filter((x) => x.plan && rateFamilyKey(x.plan.fr) === key);
        if (sameFamily.length) pool = sameFamily;
      }
      const refundableChoice = bestOf(pool).row;
      // Below REFUND_PREMIUM_FLOOR the non-refundable row isn't a real
      // trade-off, so drop it and keep only the refundable one rather than
      // showing two rows for what is really one obvious choice.
      if (refundableChoice.total - chosen.row.total < REFUND_PREMIUM_FLOOR) {
        out[0] = refundableChoice;
      } else {
        out.push(refundableChoice);
      }
    }
  } else if (refundable.length) {
    out.push(bestOf(refundable).row);
  }
  return out;
}

function pickRoomName(names: string[], room: RoomInfo | null, hotelName: string): string {
  // How much a candidate actually tells a guest: bed count/type, view,
  // accessibility, suite. Shortest-wins alone picks the most TRUNCATED name,
  // which is how "Room, 1 King Bed, Mountain View" once rendered as "Room".
  const info = (t: string) =>
    (t.match(/king|queen|double|twin|single|bunk|suite|studio|view|accessib|mobility|hearing|deluxe|superior/gi) ?? [])
      .length;
  const titles = names.map((n) => deriveRoomTitle(n, room, hotelName)).filter(Boolean);
  if (!titles.length) return "Room";
  return titles.sort((a, b) => info(b) - info(a) || a.length - b.length || a.localeCompare(b))[0];
}

export async function getHotelDetail(input: {
  hotelId: string;
  checkin: string;
  nights: number;
  isMember?: boolean;
}): Promise<HotelDetail> {
  const nights = Math.max(1, Math.min(30, Math.round(input.nights)));
  const checkout = addDays(input.checkin, nights);

  // This page is where a room is chosen, so this is where a BOOKABLE offer has
  // to exist — which means it is where the margin gets applied.
  //
  // Cap 2000, not 50: rates come back sorted cheapest first, and now that
  // package rates are excluded from booking entirely, the standard-only
  // stream needs to go much deeper before a refundable plan shows up — cap 50
  // was tuned back when package (which happens to skew cheaper/refundable
  // more often) was still in the mix. Verified live on Hilton NOLA, the
  // worst-case hotel we've tested: at cap 50, only 17 standard plans survive
  // filtering and ZERO are refundable; the first standard+refundable plan
  // doesn't appear until ~600 deep. Latency was measured flat at ~6-10s from
  // cap 400 to cap 1000 (supplier fan-out bound, not payload size). Raised
  // 800 -> 2000 to also give pickPerCancellation's same-rate-family pairing
  // (below) a same-supplier refundable sibling to find, not just any
  // refundable plan that happens to be within reach — re-measure latency if
  // this cap moves again.
  const RATE_FETCH_CAP = 2000;
  const [detail, baseline, rawReviews, taxSchema] = await Promise.all([
    hotelDetail(input.hotelId),
    searchRatesForDetail(input.hotelId, input.checkin, checkout, RATE_FETCH_CAP, 0),
    hotelReviews(input.hotelId),
    hotelTaxSchema(input.hotelId),
  ]);

  // Everything a fee line needs to be named honestly: the stay length (a filed
  // per-night amount only matches once multiplied out), the party size, and the
  // property's own levies.
  const feeCtx = { nights, adults: 2, schema: taxSchema };

  // The margin for this hotel, decided from the only trustworthy reading of
  // net and SSP. Taken from the cheapest sellable plan, because `margin` is
  // per-request: one number has to cover every room on the page.
  //
  // Note we cannot instead price each plan on its own SSP and re-match later —
  // no identifier survives a margin change. Measured across 50 plans: offerId
  // and rateId 0/50, roomTypeId 10/50, rateCode has only 2 distinct values.
  // So the priced call below is the one whose offerIds we hand to the guest.
  // Package rates are excluded from the room-only booking flow entirely (see
  // the candidate filter below), so they must not set the margin either —
  // it's per-request and has to match the standard-rate inventory we actually
  // sell.
  // Every standard plan contributes evidence, and the TIGHTEST parity ceiling
  // across them wins, because this one margin applies to every room rendered
  // on the page. A plan with no sourced SSP imposes no ceiling rather than
  // disqualifying the hotel — the gate-vs-ceiling distinction in pricing.ts.
  const evidence: RateEvidence[] = (baseline[0]?.roomTypes ?? [])
    .filter((rt: any) => rt?.rateType !== "package")
    .map(
      (rt: any): RateEvidence => ({
        net: rt?.offerRetailRate?.amount,
        ssp: rt?.suggestedSellingPrice?.amount ?? null,
        source: rt?.suggestedSellingPrice?.source ?? null,
      }),
    )
    .filter((e: RateEvidence) => typeof e.net === "number" && e.net > 0);

  // The whole member tier is this one argument. The baseline call above is
  // margin 0 either way; only the PRICED call below differs, and it was always
  // going to happen. Nothing here adds a request.
  //
  // If this result is ever memoised to cut the page's latency, the cache key
  // MUST include isMember. Sharing one entry between a member and a signed-out
  // visitor hands member pricing to the public.
  const marginPct = marginFor(evidence, { isMember: input.isMember });

  // Same retry as the baseline: an empty PRICED response would blank the page
  // just as effectively, and it flaps independently of the call above.
  const rates = await searchRatesForDetail(
    input.hotelId,
    input.checkin,
    checkout,
    RATE_FETCH_CAP,
    marginPct,
  );

  const reviews = buildReviewSnippets(rawReviews);
  const images = buildGallery(detail);
  const catalog = buildRoomCatalog(detail);
  const entry = rates[0];

  // Package rates are meant for bundling with flights/cars or for closed-user-
  // group discounting (LiteAPI's own doc: "not recommended to build fencing
  // logic solely on this flag") — neither applies to a plain room-only
  // booking, so they're dropped before anything else touches this list.
  // Measured cost of doing the opposite: on 12 real hotels, package rates held
  // the cheapest price in 45% of comparable room+option cells, so this is a
  // real inventory cut, not free — it's a scope choice for now, to be
  // revisited once car/activity packages exist to bundle them into.
  const priced = (entry?.roomTypes ?? []).filter((rt: any) => rt?.rateType !== "package");

  // Group by the PHYSICAL room. `mappedRoomId` sits on the rate, not the room
  // type — `roomTypeId` is 1:1 with plans (measured: 303 ids for 303 plans) and
  // cannot group anything. A plan the mapper couldn't place still gets a group
  // of its own, keyed off its cleaned name, so no price is ever silently lost.
  const groups = new Map<string, Plan[]>();
  for (const rt of priced) {
    const fr = rt?.rates?.[0];
    if (!rt?.offerId || !fr || typeof rt?.offerRetailRate?.amount !== "number") continue;
    const name = fr.name || "";
    const key =
      fr.mappedRoomId != null
        ? `m${fr.mappedRoomId}`
        : `n${(describeRoomName(name) || name).toLowerCase()}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push({ rt, fr, name });
  }

  // Is breakfast this property's amenity rather than a product? Decided once
  // per hotel, from the whole plan set, behind a gate strict enough that a
  // hotel which really sells breakfast can never pass it:
  //
  //   1. EVERY mapped room has at least one breakfast rate. One room without
  //      any is enough to conclude the kitchen is not feeding all guests.
  //   2. Wherever the same room offers both boards under the same cancellation
  //      terms, the premium is below the floor — i.e. nobody is paying for it.
  //
  // When both hold, a supplier's "Room Only" is a data artifact, not an
  // exclusion, and we say breakfast is included. This IS a claim beyond what
  // that supplier stated, so the gate carries the weight: on lp85c07 all 6
  // rooms have a breakfast rate and the largest premium anywhere is $5.65 for
  // two people over two nights.
  const assumeBreakfast = (() => {
    const floor = BREAKFAST_FLOOR_PER_PERSON_NIGHT * 2 * Math.max(1, nights);
    const rooms = [...groups.values()];
    if (!rooms.length) return false;
    const bf = (p: Plan) =>
      BREAKFAST_BOARDS.has(p.fr.boardType || "RO") || /breakfast/i.test(p.fr.boardName || "");
    if (!rooms.every((plans) => plans.some(bf))) return false;
    for (const plans of rooms) {
      for (const tag of ["RFN", "NRFN"]) {
        const inTag = plans.filter(
          (p) => (p.fr.cancellationPolicies?.refundableTag || "") === tag,
        );
        const cost = (p: Plan) => p.rt.offerRetailRate.amount;
        const withBf = inTag.filter(bf).map(cost);
        const without = inTag.filter((p) => !bf(p)).map(cost);
        if (!withBf.length || !without.length) continue;
        if (Math.min(...withBf) - Math.min(...without) > floor) return false;
      }
    }
    return true;
  })();

  // Cancellation deadlines arrive as GMT wall-clock (measured: `timezone` was
  // "GMT" on all 255 tier entries of one hotel) and LiteAPI publishes no
  // property timezone. Derived once here from the coordinates we already hold,
  // then shared by every rate on the page — tz-lookup is a table scan, cheap
  // but not free, and every rate at this hotel is in the same zone by
  // definition.
  const zone = zoneFor(detail?.location?.latitude, detail?.location?.longitude);

  const options: RoomOption[] = [];
  for (const [roomId, plans] of groups) {
    const names = [...new Set(plans.map((p) => p.name).filter(Boolean))];
    // Static room content (beds, size, photos, amenities) still comes from the
    // hotel's own catalog in /data/hotel; it is matched on the base name, which
    // is far cleaner now that the spec-sheet variants have collapsed into it.
    const room = matchRoom(names.join(" "), catalog);
    const title = pickRoomName(names, room, detail?.name || "");

    const rows: RoomRate[] = plans.map(({ rt, fr }): RoomRate => {
      // ALREADY marked up — this response carried `marginPct`. It is the amount
      // LiteAPI will charge, and `rt.offerId` is bookable as-is. Rounded up only
      // for display; the charge stays at the exact cent.
      const you = Math.ceil(rt.offerRetailRate.amount);
      const boardType = fr.boardType || "RO";
      const board = fr.boardName || "Room only";
      // Classified, not guessed. A resort fee is never described as a tax, and
      // the amount is used verbatim because LiteAPI has already multiplied any
      // per-night charge across the stay. See src/lib/fees.ts.
      const feeInfo = summarizeFees(fr.retailRate?.taxesAndFees, feeCtx);
      const fee = Math.round(feeInfo.dueAtPropertyTotal);
      // Not just the tag: a rate can be filed RFN with its free window already
      // in the past (booked inside the cancellation window), and calling that
      // "free cancellation" would be false. buildCancelPolicy checks the clock.
      const cancel = buildCancelPolicy(
        fr.cancellationPolicies,
        you,
        zone,
      );
      const freeCancel = cancel.refundable;
      const them = compareAtPrice(you, evidence);
      const breakfast =
        assumeBreakfast || BREAKFAST_BOARDS.has(boardType) || /breakfast/i.test(board);
      return {
        offerId: rt.offerId,
        board,
        boardLabel: breakfast && !/breakfast/i.test(board) ? "Breakfast included" : board,
        breakfast,
        freeCancel,
        freeCancelUntil: cancel.freeUntilShort,
        freeCancelUntilLong: cancel.freeUntilLong,
        cancelTiers: describeTiers(cancel, rt.offerRetailRate?.currency || "USD"),
        mandatory: feeInfo.note,
        fee,
        sleeps: fr.maxOccupancy || room?.sleeps || 2,
        you,
        // Never read suggestedSellingPrice from a priced response — LiteAPI
        // marks it up too, so it would be our own price times our own margin.
        // A plan we don't actually beat shows no comparison at all.
        them: them === null ? null : Math.round(them),
        total: you + fee,
        currency: rt.offerRetailRate?.currency || "USD",
      };
    });

    // Cheapest by TOTAL, not by rate: two suppliers can differ by $50 in what
    // the guest actually pays while the lower headline rate is the worse deal.
    const rates_ = pickPerCancellation(rows, plans, nights).sort((a, b) => a.total - b.total);
    if (!rates_.length) continue;

    options.push({
      roomId,
      title,
      beds: room?.beds || guessBeds(names[0] || ""),
      size: room?.size ?? null,
      sleeps: Math.max(...rates_.map((r) => r.sleeps)),
      amenities: [...new Set((room?.amenities ?? []).map(tidyLabel))].slice(0, 5),
      image: room?.photos?.[0] ?? images[0] ?? null,
      supplierNames: names.length,
      rates: rates_,
      from: rates_[0].total,
      currency: rates_[0].currency,
    });
  }

  // Cheapest room first, by what the guest actually pays. Every mapped room is
  // kept: the mapping has already done the deduplication, so trimming further
  // would be us hiding real inventory rather than removing noise.
  const merged = mergeIdenticalRooms(options, nights).sort((a, b) => a.from - b.from);

  return {
    hotel: {
      id: input.hotelId,
      name: detail?.name || "",
      city: detail?.city || "",
      address: detail?.address || "",
      postcode: detail?.zip || null,
      lat: typeof detail?.location?.latitude === "number" ? detail.location.latitude : null,
      lng: typeof detail?.location?.longitude === "number" ? detail.location.longitude : null,
      stars: Math.round(detail?.stars || detail?.starRating || 0),
      photo: detail?.main_photo || detail?.thumbnail || images[0] || null,
      rating: typeof detail?.rating === "number" ? detail.rating : null,
      reviewCount: detail?.reviewCount || 0,
      currency: detail?.currency || "USD",
    },
    images,
    facilities: pickFacilities(detail),
    checkinTime: detail?.checkinCheckoutTimes?.checkin_start ?? null,
    checkoutTime: detail?.checkinCheckoutTimes?.checkout ?? null,
    reviews,
    reviewsTotal: detail?.reviewCount || 0,
    description: parseDescription(detail?.hotelDescription || ""),
    importantInfo: splitImportantInfo(detail?.hotelImportantInformation || ""),
    pros: (detail?.sentiment_analysis?.pros ?? []).slice(0, 4),
    cons: (detail?.sentiment_analysis?.cons ?? []).slice(0, 4),
    sentiment: buildSentiment(detail),
    facts: {
      chain: detail?.chain || null,
      phone: detail?.phone || null,
      hotelType: detail?.hotelType || null,
      parking: detail?.parking || null,
      petsAllowed: typeof detail?.petsAllowed === "boolean" ? detail.petsAllowed : null,
      childAllowed: typeof detail?.childAllowed === "boolean" ? detail.childAllowed : null,
      airportCode: detail?.airportCode || null,
      postcode: detail?.zip || null,
    },
    accessibility: buildAccessibility(detail),
    accessibilityCertificate: detail?.accessibility?.certificateUrl || null,
    allFacilities: buildAllFacilities(detail),
    options: merged,
    breakfastAllRates:
      merged.length > 0 && merged.every((o) => o.rates.every((r) => r.breakfast)),
  };
}

// LiteAPI's mapping is good but not complete: verified live on Kimpton Arras,
// "Room, 1 King Bed, Mountain View" and "1 King Bed Room with Mountain View"
// came back under two different mappedRoomIds. They are one room worded twice.
//
// The merge is deliberately the strictest rule that catches that case: two
// rooms combine only when their titles carry the SAME set of descriptive
// words, ignoring order and filler. "King Room" never merges with "King Suite",
// and an accessible variant never merges with the room it is a variant of,
// because the word sets differ. Anything looser would start hiding real,
// separately bookable products — which is the failure the hardcoded catalog had.
const TITLE_FILLER = new Set(["with", "and", "the", "a", "in", "of"]);

function titleTokens(t: string): string {
  return [
    ...new Set(
      t
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w && !TITLE_FILLER.has(w)),
    ),
  ]
    .sort()
    .join(" ");
}

function mergeIdenticalRooms(rooms: RoomOption[], nights: number): RoomOption[] {
  const byTokens = new Map<string, RoomOption>();
  for (const room of rooms) {
    const key = titleTokens(room.title);
    const cur = byTokens.get(key);
    if (!cur) {
      byTokens.set(key, room);
      continue;
    }
    // Same room, two ids: pool the rates and re-apply the one-per-combination
    // rule, so the guest sees the cheaper supplier for each board/cancellation
    // choice rather than two look-alike cards.
    // Same one-axis rule over the pooled rates: two ids for one room must not
    // produce four rows.
    const rates = pickPerCancellation([...cur.rates, ...room.rates], null, nights).sort(
      (a, b) => a.total - b.total,
    );
    byTokens.set(key, {
      ...cur,
      // Keep whichever card had real room content behind it.
      image: cur.image ?? room.image,
      size: cur.size ?? room.size,
      beds: cur.beds || room.beds,
      amenities: cur.amenities.length ? cur.amenities : room.amenities,
      supplierNames: cur.supplierNames + room.supplierNames,
      rates,
      from: rates[0].total,
    });
  }
  return [...byTokens.values()];
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
    // Deliberately NOT HOTEL_LIMIT. This is an inspiration strip showing eight
    // tiles on an unsearched landing page, and several of them run in parallel.
    // Pulling 300 hotels per row to display 8 would be waste, not depth.
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
