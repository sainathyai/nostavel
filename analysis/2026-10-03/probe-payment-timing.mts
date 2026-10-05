/**
 * NOS-10 spike: when does the guest's money actually move, and what can we
 * learn about a charge after the fact?
 *
 * Why this exists: src/lib/booking-service.ts treats a non-null
 * `transactionId` as proof that the guest was charged ("No guest charge, no
 * booking"), and the NOS-5 fix was going to rely on the same signal to stop the
 * sweeper expiring a row mid-payment. If `/rates/prebook` hands back a
 * transactionId *before* any money moves, that signal proves nothing and the
 * fix has to find another one. Everything else in Segment 4's sweeper design
 * follows from the answer.
 *
 * Sandbox only, asserted below. Writes raw responses next to this file
 * (gitignored, conventions section 8) and prints a summary with no credential
 * in it. Run: npx tsx analysis/2026-10-03/probe-payment-timing.mts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "raw");
mkdirSync(OUT, { recursive: true });

process.loadEnvFile(join(HERE, "..", "..", ".env.local"));
const KEY = (process.env.LITEAPI_KEY ?? "").trim();
const BASE = process.env.LITEAPI_BASE_URL || "https://api.liteapi.travel/v3.0";

if (!KEY) throw new Error("LITEAPI_KEY is not set in .env.local");
if (!KEY.startsWith("sand_")) {
  // A live key would charge real cards and create real bookings.
  throw new Error("refusing to run: LITEAPI_KEY is not a sandbox key (expected the sand_ prefix)");
}

/** Never returns the key or any header. */
async function call(method: string, path: string, body?: unknown) {
  const url = path.startsWith("http") ? path : BASE + path;
  const res = await fetch(url, {
    method,
    headers: { "X-API-Key": KEY, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 400) };
  }
  const name = `${method}_${path.replace(/[^a-z0-9]+/gi, "_").slice(0, 60)}.json`;
  writeFileSync(join(OUT, name), JSON.stringify({ method, path, status: res.status, json }, null, 2));
  return { status: res.status, json: json as Record<string, any> };
}

const keysOf = (o: unknown): string[] => (o && typeof o === "object" ? Object.keys(o as object) : []);
const line = (s: string) => console.log(s);

// ---------------------------------------------------------------------------
// Q1 + Q2: what prebook returns, and whether a transactionId exists before any
// money has moved.
// ---------------------------------------------------------------------------
const checkin = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
const checkout = new Date(Date.now() + 32 * 86400000).toISOString().slice(0, 10);

// Nothing derived from the key is printed, not even its length: CodeQL's
// clear-text-logging rule flags any value that flows from the credential into
// a log sink, and it is right to - a length is weak information, but there is
// no reason to emit it. The prefix check above already proved the key is the
// sandbox one.
line("base: " + BASE + "  key: sandbox prefix verified");
line(`dates: ${checkin} -> ${checkout}\n`);

const hotels = await call("GET", `/data/hotels?countryCode=US&cityName=New%20York&limit=5`);
const hotelIds: string[] = (hotels.json?.data ?? []).map((h: any) => h.id).filter(Boolean);
line(`Q0 hotels: HTTP ${hotels.status}, ${hotelIds.length} id(s)`);
if (!hotelIds.length) throw new Error("no hotels returned; cannot continue");

const rates = await call("POST", "/hotels/rates", {
  hotelIds: hotelIds.slice(0, 3),
  occupancies: [{ adults: 2 }],
  currency: "USD",
  guestNationality: "US",
  checkin,
  checkout,
});
const firstRate = (rates.json?.data ?? [])
  .flatMap((h: any) => h.roomTypes ?? [])
  .flatMap((rt: any) => rt.rates ?? [])[0];
const offerId: string | undefined = (rates.json?.data ?? [])
  .flatMap((h: any) => h.roomTypes ?? [])
  .map((rt: any) => rt.offerId)
  .filter(Boolean)[0];
line(`Q0 rates: HTTP ${rates.status}, offerId ${offerId ? "found" : "MISSING"}, rate keys: ${keysOf(firstRate).join(",") || "-"}`);
if (!offerId) throw new Error("no offerId in rates response; cannot prebook");

const prebook = await call("POST", "/rates/prebook", { offerId, usePaymentSdk: true });
const pb = prebook.json?.data ?? prebook.json;
line(`\nQ1 prebook: HTTP ${prebook.status}`);
line(`   fields: ${keysOf(pb).join(", ")}`);
line(`   prebookId:      ${pb?.prebookId ? "present" : "absent"}`);
line(`   transactionId:  ${pb?.transactionId ? "PRESENT BEFORE ANY CHARGE" : "absent"}`);
line(`   secretKey:      ${pb?.secretKey ? "present (card session)" : "absent"}`);
for (const k of ["expiresAt", "expiry", "ttl", "validUntil", "expiresIn", "priceType", "paymentStatus", "status"]) {
  if (pb && k in pb) line(`   ${k}: ${JSON.stringify(pb[k])}`);
}

// ---------------------------------------------------------------------------
// Q5: is there anything that tells us about a transaction after the fact -
// status, void, refund? Probe shapes without committing to one; a 404 means
// "no such route", a 400/422 means the route exists and disliked our input.
// ---------------------------------------------------------------------------
const txId: string | undefined = pb?.transactionId;
line(`\nQ5 transaction endpoints (404 = no route, 400/401/422 = route exists):`);
const probes: Array<[string, string]> = [
  ["GET", `/payments/${txId ?? "unknown"}`],
  ["GET", `/transactions/${txId ?? "unknown"}`],
  ["GET", `/rates/prebook/${pb?.prebookId ?? "unknown"}`],
  ["POST", `/payments/${txId ?? "unknown"}/refund`],
  ["POST", `/payments/${txId ?? "unknown"}/void`],
];
for (const [method, path] of probes) {
  const r = await call(method, path, method === "POST" ? {} : undefined);
  const msg = String(r.json?.error?.message ?? r.json?.message ?? "").slice(0, 80);
  const empty = r.json && typeof r.json === "object" && "raw" in r.json && !String((r.json as any).raw).trim();
  line(`   ${method} ${path} -> ${r.status} ${empty ? "EMPTY BODY (no such route)" : msg || "has a body"}`);
}

// ---------------------------------------------------------------------------
// Q3: does book() succeed against a transaction nobody paid? Only runs with
// --book, because it creates a sandbox booking. This is the question that
// decides whether "charged" is verifiable by attempting the booking.
// ---------------------------------------------------------------------------
if (process.argv.includes("--book") && pb?.prebookId && txId) {
  line(`\nQ3 book with an unpaid transaction (sandbox):`);
  const booked = await call("POST", "/rates/book", {
    prebookId: pb.prebookId,
    holder: { firstName: "Probe", lastName: "Tester", email: "probe@example.com" },
    guests: [{ occupancyNumber: 1, firstName: "Probe", lastName: "Tester", email: "probe@example.com" }],
    payment: { method: "TRANSACTION_ID", transactionId: txId },
  });
  const bd = booked.json?.data ?? booked.json;
  line(`   HTTP ${booked.status}  status=${JSON.stringify(bd?.status)}  bookingId=${bd?.bookingId ?? "-"}`);
  line(`   error: ${String(bd?.error?.message ?? booked.json?.error?.message ?? "-").slice(0, 160)}`);
  // Inference has to distinguish "the supplier refused this booking" from "the
  // supplier did not answer the question". A 429 says nothing about payment.
  if (booked.status === 200) {
    line("   VERDICT: booked with no payment - the supplier does NOT verify the charge at book time");
  } else if (booked.status === 429) {
    line("   VERDICT: inconclusive - rate limited (429). Re-run after the limit resets; this proves nothing about payment.");
  } else if (booked.status >= 400 && booked.status < 500) {
    line(`   VERDICT: refused with ${booked.status} - read the error above before concluding it was about payment`);
  } else {
    line(`   VERDICT: inconclusive - HTTP ${booked.status}`);
  }
} else {
  line(`\nQ3 skipped (pass --book to attempt a booking against an unpaid transaction)`);
}

line(`\nraw responses: ${OUT}`);
