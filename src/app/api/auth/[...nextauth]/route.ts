// Auth.js mounts its whole flow (OAuth callbacks, magic-link verify, sign-out)
// on this catch-all route.
import { handlers } from "@/auth";

export const { GET, POST } = handlers;
