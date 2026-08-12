import { searchStaysInArea } from "@/lib/liteapi";

// Backs the map's "search this area" refresh: the client sends the current
// viewport as a center + radius after a user-driven pan/zoom, we return the
// hotels + live rates for that circle so the pins can update in place.
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const lat = Number(params.get("lat"));
  const lng = Number(params.get("lng"));
  const radius = Number(params.get("radius"));
  const checkin = params.get("checkin") || "";
  const nights = Number(params.get("nights"));

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(radius) || !checkin) {
    return Response.json({ error: "bad params" }, { status: 400 });
  }

  try {
    const items = await searchStaysInArea({ lat, lng, radius, checkin, nights });
    return Response.json({ items });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "search failed" }, { status: 502 });
  }
}
