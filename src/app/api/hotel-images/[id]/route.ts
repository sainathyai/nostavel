import { getHotelCardExtras } from "@/lib/liteapi";
import { reportFailure } from "@/lib/action-error";

// Image gallery + amenity icons for a search-result card — fetched once on
// mount (queued client-side, see fetch-queue.ts) rather than for all 30
// cards at once.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!id) return Response.json({ error: "missing hotel id" }, { status: 400 });

  try {
    const extras = await getHotelCardExtras(id);
    return Response.json(extras);
  } catch (err) {
    // NOS-11: relayed the supplier's own error text to an unauthenticated
    // caller. Not named in the ticket; same defect as the other routes.
    return Response.json({ error: reportFailure("hotel-extras", err).error }, { status: 502 });
  }
}
