import { config } from "dotenv";
config({ path: ".env.local" });
const KEY = process.env.LITEAPI_KEY!;
const bookingId = process.argv[2];
const r = await fetch(`https://api.liteapi.travel/v3.0/bookings/${bookingId}`, {
  method: "PUT",
  headers: { "X-API-Key": KEY },
});
console.log("status:", r.status);
console.log(JSON.stringify(await r.json(), null, 2));
