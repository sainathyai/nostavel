import { book } from "@/lib/liteapi";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { prebookId, firstName, lastName, email } = body;
    if (!prebookId || !firstName || !lastName || !email) {
      return Response.json(
        { error: "prebookId, firstName, lastName and email are required" },
        { status: 400 },
      );
    }
    const data = await book({ prebookId, firstName, lastName, email });
    return Response.json(data);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
