/**
 * Verifies REFUND_PREMIUM_FLOOR (liteapi.ts): rooms whose refund premium is
 * under $20 should now show one row, not two. Scans several hotels and prints
 * every room that still has both a non-refundable and refundable row, plus
 * the premium — anything under $20 here is a bug.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

const { Module } = await import("node:module");
const { fileURLToPath } = await import("node:url");
const origResolve = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (req: string, ...rest: unknown[]) {
  if (req === "server-only")
    return fileURLToPath(new URL("../2026-08-21/_noop.cjs", import.meta.url));
  return origResolve.call(this, req, ...rest);
};

const { getHotelDetail } = await import("../../src/lib/liteapi");

const ids = ["lp1b919", "lp657d352a", "lp225d01", "lp40992", "lp85c07"];
const checkin = new Date(Date.now() + 45 * 864e5).toISOString().slice(0, 10);

for (const hotelId of ids) {
  try {
    const d = await getHotelDetail({ hotelId, checkin, nights: 2, isMember: false });
    let sawPair = false;
    for (const opt of d.options ?? []) {
      const rates = opt.rates ?? [];
      const nrfn = rates.find((r: any) => !r.freeCancel);
      const rfn = rates.find((r: any) => r.freeCancel);
      if (nrfn && rfn) {
        sawPair = true;
        const premium = rfn.total - nrfn.total;
        console.log(
          `  ${hotelId}  ${opt.title}: NRFN $${nrfn.total.toFixed(2)} vs RFN $${rfn.total.toFixed(2)}  premium $${premium.toFixed(2)}` +
            (premium < 20 ? "   <-- SHOULD HAVE COLLAPSED" : ""),
        );
      }
    }
    if (!sawPair) console.log(`  ${hotelId}: no room shows both rows (all collapsed or single-option)`);
  } catch (e) {
    console.log(`  ${hotelId}: ${(e as Error).message}`);
  }
}
