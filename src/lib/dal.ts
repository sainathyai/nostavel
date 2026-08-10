// Data Access Layer — the single place that resolves "who is the current user?"
// Per Next 16's auth guidance we do auth checks here (server components / actions /
// route handlers), NOT in middleware/proxy. `cache` dedupes the lookup within a
// single render pass so multiple callers don't each hit the session store.
import "server-only";
import { cache } from "react";
import { auth } from "@/auth";

export const getSession = cache(async () => auth());

export const getCurrentUser = cache(async () => {
  const session = await auth();
  return session?.user ?? null;
});
