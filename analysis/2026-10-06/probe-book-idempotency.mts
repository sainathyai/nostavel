/**
 * NOS-6: what does the supplier do when `book()` is called TWICE with the same
 * prebookId and transactionId?
 *
 * Why this exists: the fix for NOS-6 adds a claim step so only one caller can
 * finalize a booking. How much that matters depends on what the supplier does
 * with the second call it never should have received - one booking returned
 * twice is a very different problem from two rooms reserved and two charges.
 * LiteAPI's documentation does not say (checked 2026-10-06:
 * docs.liteapi.travel/docs/user-payment is silent on idempotency), so the only
 * way to know is to ask it.
 *
 * Also settles NOS-45's open question: does book() refuse a transaction nobody
 * paid for? The earlier probe got HTTP 429 and could not tell.
 *
 * Sandbox only, asserted below. Unlike the first probe this one walks every
 * offer until one prebooks - "no prebook availability" on the first offer is
 * what made the earlier run inconclusive, and it is a property of sandbox
 * inventory, not of the question.
 *
 * Run: npx tsx analysis/2026-10-06/probe-book-idempotency.mts [--book]
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
  throw new Error("refusing to run: LITEAPI_KEY is not a sandbox key (expected the sand_ prefix)");
}

let seq = 0;
async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
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
  const name = `${String(++seq).padStart(2, "0")}_${method}_${path.replace(/[^a-z0-9]+/gi, "_").slice(0, 50)}.json`;
  writeFileSync(join(OUT, name), JSON.stringify({ method, path, status: res.status, json }, null, 2));
  return { status: res.status, json: json as Record<string, any> };
}

const line = (s: string) => console.log(s);
const err = (r: { json: Record<string, any> }) =>
  String(r.json?.error?.message ?? r.json?.error?.description ?? r.json?.message ?? "").slice(0, 90);

line("base: " + BASE + "  key: sandbox prefix verified");

const checkin = new Date(Date.now() + 45 * 86400000).toISOString().slice(0, 10);
const checkout = new Date(Date.now() + 47 * 86400000).toISOString().slice(0, 10);
line(`dates: ${checkin} -> ${checkout}\n`);

const hotels = await call("GET", `/data/hotels?countryCode=US&cityName=New%20York&limit=25`);
const hotelIds: string[] = (hotels.json?.data ?? []).map((h: any) => h.id).filter(Boolean);
line(`hotels: HTTP ${hotels.status}, ${hotelIds.length} id(s)`);

const rates = await call("POST", "/hotels/rates", {
  hotelIds: hotelIds.slice(0, 15),
  occupancies: [{ adults: 2 }],
  currency: "USD",
  guestNationality: "US",
  checkin,
  checkout,
});
const offerIds: string[] = (rates.json?.data ?? [])
  .flatMap((h: any) => h.roomTypes ?? [])
  .map((rt: any) => rt.offerId)
  .filter(Boolean);
line(`rates: HTTP ${rates.status}, ${offerIds.length} offer(s)\n`);
if (!offerIds.length) throw new Error("no offers returned; cannot continue");

// WALK THE OFFERS. Sandbox inventory refuses most prebooks with "no prebook
// availability" (code 2001), which is what made the 2026-10-03 run
// inconclusive. Stop at the first one that actually holds.
let pb: Record<string, any> | null = null;
for (const [i, offerId] of offerIds.slice(0, 12).entries()) {
  const r = await call("POST", "/rates/prebook", { offerId, usePaymentSdk: true });
  const d = r.json?.data ?? r.json;
  if (r.status === 200 && d?.prebookId) {
    pb = d;
    line(`prebook: offer ${i + 1}/${Math.min(12, offerIds.length)} held`);
    break;
  }
  line(`prebook: offer ${i + 1} -> HTTP ${r.status} ${err(r)}`);
}
if (!pb) throw new Error("no offer could be prebooked; sandbox inventory");

line(`   prebookId:     ${pb.prebookId}`);
line(`   transactionId: ${pb.transactionId ? "PRESENT BEFORE ANY CHARGE" : "absent"}`);
line(`   secretKey:     ${pb.secretKey ? "present (card session)" : "absent"}`);
for (const k of ["expiresAt", "expiry", "ttl", "validUntil", "expiresIn", "paymentStatus", "status"]) {
  if (k in pb) line(`   ${k}: ${JSON.stringify(pb[k])}`);
}

if (!process.argv.includes("--book")) {
  line(`\nskipped the booking attempts (pass --book). raw: ${OUT}`);
  process.exit(0);
}

const holder = { firstName: "Probe", lastName: "Tester", email: "probe@example.com" };
const payload = {
  prebookId: pb.prebookId,
  holder,
  guests: [{ occupancyNumber: 1, ...holder }],
  payment: { method: "TRANSACTION_ID", transactionId: pb.transactionId },
};

// Q1: does book() refuse a transaction nobody paid for? (NOS-45, left open.)
line(`\nQ1 book with an UNPAID transaction:`);
const first = await call("POST", "/rates/book", payload);
const fd = first.json?.data ?? first.json;
line(`   HTTP ${first.status}  status=${JSON.stringify(fd?.status)}  bookingId=${fd?.bookingId ?? "-"}`);
line(`   error: ${err(first) || "-"}`);
if (first.status === 429) {
  line(`   VERDICT: inconclusive - rate limited. Proves nothing about payment.`);
  process.exit(0);
}
if (first.status === 200 && fd?.bookingId) {
  line(`   VERDICT: booked with NO payment - book() does NOT verify the charge.`);
} else if (first.status >= 400 && first.status < 500) {
  line(`   VERDICT: refused with ${first.status}. Read the error above before`);
  line(`            concluding it was about payment rather than the payload.`);
  process.exit(0);
} else {
  line(`   VERDICT: inconclusive - HTTP ${first.status}`);
  process.exit(0);
}

// Q2: the NOS-6 question. Same prebookId, same transactionId, second call.
line(`\nQ2 the SAME book() call again (this is the NOS-6 scenario):`);
const second = await call("POST", "/rates/book", payload);
const sd = second.json?.data ?? second.json;
line(`   HTTP ${second.status}  status=${JSON.stringify(sd?.status)}  bookingId=${sd?.bookingId ?? "-"}`);
line(`   error: ${err(second) || "-"}`);

const a = fd?.bookingId ? String(fd.bookingId) : null;
const b = sd?.bookingId ? String(sd.bookingId) : null;
if (second.status === 200 && b && a && b === a) {
  line(`   VERDICT: IDEMPOTENT - same bookingId returned. A duplicate finalize is`);
  line(`            absorbed by the supplier; our own duplicate ledger rows are`);
  line(`            then the whole of the harm.`);
} else if (second.status === 200 && b && a && b !== a) {
  line(`   VERDICT: TWO SEPARATE BOOKINGS (${a} and ${b}). A duplicate finalize`);
  line(`            reserves a second room. The claim step is load-bearing.`);
} else if (second.status >= 400) {
  line(`   VERDICT: REFUSED on the second call. The supplier itself is the guard;`);
  line(`            our claim step prevents a confusing error, not a double booking.`);
} else {
  line(`   VERDICT: inconclusive - HTTP ${second.status}`);
}

line(`\nraw responses: ${OUT}`);
