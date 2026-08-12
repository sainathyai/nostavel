import { getHotelCardExtras } from "@/lib/liteapi";

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
    return Response.json({ error: err instanceof Error ? err.message : "fetch failed" }, { status: 502 });
  }
}
