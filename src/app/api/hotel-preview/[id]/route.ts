import { getHotelPreview } from "@/lib/liteapi";

// Backs the results-page preview modal: photos, amenities, facilities,
// reviews, check-in/out times — everything except rates (the modal doesn't
// book; "Explore rooms" hands that off to the full /stay page).
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!id) return Response.json({ error: "missing hotel id" }, { status: 400 });

  try {
    const preview = await getHotelPreview(id);
    return Response.json(preview);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "fetch failed" }, { status: 502 });
  }
}
