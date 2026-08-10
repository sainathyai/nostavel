import { getHotelDetail } from "@/lib/liteapi";

export async function POST(request: Request) {
  try {
    const { hotelId, checkin, nights } = await request.json();
    if (!hotelId || !checkin) {
      return Response.json({ error: "hotelId and checkin are required" }, { status: 400 });
    }
    const data = await getHotelDetail({ hotelId, checkin, nights: Number(nights) || 2 });
    return Response.json(data);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
