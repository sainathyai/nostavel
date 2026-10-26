import { searchStaysInArea } from "@/lib/liteapi";
import { getCurrentUser } from "@/lib/dal";
import { clientIp } from "@/lib/rate-limit";
import { rateLimit } from "@/lib/rate-limit-store";
import { reportFailure } from "@/lib/action-error";

// Backs the map's "Search this area" button: the client sends the current
// viewport as a center + radius when the guest ASKS for it, and we return the
// hotels + live rates for that circle so the pins can update in place.
//
// Deliberately a button, not a moveend handler. Every call here is a paid
// supplier fan-out costing ~5s, and the old debounced auto-refresh fired one on
// every pan the guest made while reading the map.
//
// Rate-limited: this was an unauthenticated GET hitting a paid API with no
// guard at all — the exact gap docs/production-readiness.md called out.
// Placeholder limit, no traffic yet to measure against.
export async function GET(request: Request) {
  const ip = await clientIp();
  const rl = await rateLimit(`stays-in-area:ip:${ip}`, {
    limit: 20,
    windowMs: 60_000,
    // A paid supplier fan-out per call.
    onStoreError: "deny",
  });
  if (!rl.ok) {
    return Response.json(
      { error: "Too many area searches. Wait a moment and try again." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } },
    );
  }

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
    // NOS-11: this used to relay the supplier's own error text to an
    // unauthenticated caller. 502 is unchanged - the upstream really did fail -
    // and the detail now goes to the log under the same reference the body
    // carries.
    return Response.json({ error: reportFailure("area-search", err).error }, { status: 502 });
  }
}
