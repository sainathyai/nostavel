/** How often is a single-hotel /hotels/rates response empty? Sizes DETAIL_RATE_ATTEMPTS. */
import { config } from "dotenv";
config({ path: ".env.local" });
const BASE = process.env.LITEAPI_BASE_URL || "https://api.liteapi.travel/v3.0";
const KEY = process.env.LITEAPI_KEY!;
const call = async (id: string) => {
  const r = await fetch(BASE + "/hotels/rates", {
    method: "POST",
    headers: { "X-API-Key": KEY, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ hotelIds: [id], occupancies: [{ adults: 2 }], currency: "USD", guestNationality: "US", checkin: "2026-09-20", checkout: "2026-09-22", maxRatesPerHotel: 2000, roomMapping: true, timeout: 5, margin: 0 }),
  });
  const d: any = await r.json().catch(() => ({}));
  return ((d.data ?? [])[0]?.roomTypes ?? []).length as number;
};
for (const [label, id] of [["Chicken Ranch (flaky)", "lp657d352a"], ["Gateway (control)", "lp6556f7f5"]] as const) {
  const N = 30;
  let empty = 0;
  const seq: number[] = [];
  for (let i = 0; i < N; i++) { const n = await call(id); seq.push(n); if (!n) empty++; }
  const p = empty / N;
  console.log(`\n  ${label}: ${empty}/${N} empty (p=${p.toFixed(2)})`);
  console.log(`    ${seq.join(" ")}`);
  for (const k of [1, 2, 3, 4, 5]) console.log(`      ${k} attempt${k > 1 ? "s" : ""}: false sold-out ${(p ** k * 100).toFixed(1)}%   worst-case extra latency ${((k - 1) * 1.2).toFixed(1)}s`);
}
