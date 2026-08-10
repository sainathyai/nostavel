import { prebook } from "@/lib/liteapi";

export async function POST(request: Request) {
  try {
    const { offerId } = await request.json();
    if (!offerId) {
      return Response.json({ error: "offerId is required" }, { status: 400 });
    }
    const data = await prebook(offerId);
    return Response.json(data);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
