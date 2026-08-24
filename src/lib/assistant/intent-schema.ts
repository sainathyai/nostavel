import { z } from "zod";
import "server-only";

// The contract the LLM must produce for interpret-query.ts. Three tiers,
// matching what's real vs. client-only vs. not-yet-supported in the backend:
//   SearchIntent      -> the real dest/checkin/nights/notes URL params
//   ClientFilterIntent -> the client-only category/sort state in Experience.tsx
//   unmet             -> things asked for with no backend field yet (price,
//                         amenities) -- passed through as notes text only
export const SearchIntentSchema = z.object({
  dest: z.string().nullable().describe("Resolved destination key from the candidate list, or null if unresolved"),
  checkin: z.string().nullable().describe("YYYY-MM-DD, or null to leave unchanged"),
  nights: z.number().int().nullable().describe("1-30, or null to leave unchanged"),
  notes: z.string().describe("Free-text preferences forwarded to relevance re-ranking (quiet, pool, pet-friendly, etc.), including any price/amenity asks the backend can't hard-filter on yet"),
});

export const ClientFilterIntentSchema = z.object({
  category: z.enum(["all", "budget", "comfort", "luxury", "convenience"]).nullable().describe("Category chip to select, or null to leave unchanged"),
  sort: z.enum(["recommended", "price_low", "price_high", "savings"]).nullable().describe("Sort order, or null to leave unchanged"),
});

export const InterpretQueryResultSchema = z.object({
  intent: SearchIntentSchema,
  clientFilter: ClientFilterIntentSchema,
  unmet: z.array(z.string()).describe("Requests the backend can't hard-filter on yet (e.g. a price ceiling, a specific amenity) -- explain briefly so the UI can be honest about it"),
  assistantReply: z.string().describe("One short sentence confirming what search was updated to"),
  clarifyingQuestion: z.string().nullable().describe("If the destination can't be resolved or the request is too vague to act on, a question to ask instead of guessing"),
});

export type SearchIntent = z.infer<typeof SearchIntentSchema>;
export type ClientFilterIntent = z.infer<typeof ClientFilterIntentSchema>;
export type InterpretQueryResult = z.infer<typeof InterpretQueryResultSchema>;
