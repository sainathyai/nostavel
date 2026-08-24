import { searchStaysInArea } from "@/lib/liteapi";
import { getCurrentUser } from "@/lib/dal";

// Backs the map's "Search this area" button: the client sends the current
// viewport as a center + radius when the guest ASKS for it, and we return the
// hotels + live rates for that circle so the pins can update in place.
//
// Deliberately a button, not a moveend handler. Every call here is a paid
// supplier fan-out costing ~5s, and the old debounced auto-refresh fired one on
// every pan the guest made while reading the map.
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
    // The map refresh has to price on the same tier as the page that opened
    // it. Reading the session here rather than trusting a query param is the
    // point: a client-supplied flag would be a free upgrade to member pricing.
    const account = await getCurrentUser();
    const result = await searchStaysInArea({
      lat, lng, radius, checkin, nights, isMember: Boolean(account),
    });
    return Response.json(result);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "search failed" }, { status: 502 });
  }
}
