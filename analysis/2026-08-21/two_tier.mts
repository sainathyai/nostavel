// The member tier, end to end against live LiteAPI, both ways.
//
// Calls the app's own getHotelDetail twice for the same hotel and dates, once
// as a member and once signed out, and prints what each visitor would be
// charged. If these two ever come back equal on a hotel with a real public
// rate, the tier is not working.
import { config } from "dotenv";
config({ path: ".env.local" });

const hotels = (process.argv[2] ?? "lp85c07,lp1b919,lp225d01,lp40992").split(",");
const checkin = new Date(Date.now() + 45 * 864e5).toISOString().slice(0, 10);

// server-only throws outside a Next request; neutralise it for this harness.
const { Module } = await import("node:module");
const { fileURLToPath } = await import("node:url");
const origResolve = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (req: string, ...rest: unknown[]) {
  if (req === "server-only") return fileURLToPath(new URL("_noop.cjs", import.meta.url));
  return origResolve.call(this, req, ...rest);
};

const { getHotelDetail } = await import("../../src/lib/liteapi");

console.log(`checkin ${checkin}, 2 nights, 2 adults\n`);
console.log(
  "hotel      cheapest room".padEnd(46) +
    "member".padStart(10) + "public".padStart(10) + "gap".padStart(9),
);
console.log("-".repeat(75));

for (const id of hotels) {
  try {
    const [member, pub] = await Promise.all([
      getHotelDetail({ hotelId: id, checkin, nights: 2, isMember: true }),
      getHotelDetail({ hotelId: id, checkin, nights: 2, isMember: false }),
    ]);
    const m = member.options?.[0]?.rates?.[0];
    const p = pub.options?.[0]?.rates?.[0];
    if (!m || !p) { console.log(`${id.padEnd(10)} no rooms`); continue; }
    const gap = p.you - m.you;
    const pct = p.you ? ((gap / p.you) * 100).toFixed(1) + "%" : "-";
    const name = (member.options[0].title ?? "").slice(0, 34);
    console.log(
      `${id.padEnd(10)} ${name.padEnd(35)}` +
        `$${m.you}`.padStart(10) + `$${p.you}`.padStart(10) + pct.padStart(9),
    );
    if (m.them) console.log(`${" ".padEnd(46)}member compare-at $${m.them}`);
  } catch (e) {
    console.log(`${id.padEnd(10)} FAILED ${(e as Error).message.slice(0, 60)}`);
  }
}
