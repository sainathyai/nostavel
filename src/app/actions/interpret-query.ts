"use server";

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { resolveDest, CATEGORY_SYNONYMS } from "@/lib/liteapi";
import { DESTINATIONS } from "@/lib/destinations";
import type { Query } from "@/lib/query-url";
import { InterpretQueryResultSchema, type InterpretQueryResult } from "@/lib/assistant/intent-schema";

const anthropic = new Anthropic();

const DESTINATION_HINTS = DESTINATIONS.map((d) => `${d.key} = ${d.label}`).join("\n");

const SYSTEM_PROMPT = `You turn a traveler's natural-language search request into structured updates for a hotel search.

Today's date: ${new Date().toISOString().slice(0, 10)}.

Curated destination keys (prefer these when the request matches one):
${DESTINATION_HINTS}

For a city not in that list, put the plain city name in "dest" (e.g. "Austin") -- it will be resolved separately. If you cannot tell what destination is meant, leave "dest" null and ask a clarifying question instead of guessing.

Category vocabulary (for "clientFilter.category"):
${Object.entries(CATEGORY_SYNONYMS)
  .map(([cat, syns]) => `${cat}: ${syns.join(", ")}`)
  .join("\n")}

Only set a SearchIntent or ClientFilterIntent field when the user's request actually implies a change -- leave everything else null. Price ceilings, specific amenities, and other asks the backend can't hard-filter on go into "notes" (for relevance re-ranking) and are also listed in "unmet" so the UI can be upfront about the limitation.`;

export type InterpretQueryInput = {
  text: string;
  current: Query;
  source: "chat" | "voice";
  history?: { role: "user" | "assistant"; text: string }[];
};

export async function interpretQuery(input: InterpretQueryInput): Promise<InterpretQueryResult> {
  const ip = await clientIp();
  const rl = rateLimit(`interpret-query:ip:${ip}`, { limit: 20, windowMs: 60_000 });
  if (!rl.ok) {
    return {
      intent: { dest: null, checkin: null, nights: null, notes: "" },
      clientFilter: { category: null, sort: null },
      unmet: [],
      assistantReply: "",
      clarifyingQuestion: "Too many requests -- please wait a moment and try again.",
    };
  }

  const historyLines = (input.history ?? [])
    .map((h) => `${h.role}: ${h.text}`)
    .join("\n");

  const userTurn = [
    `Current search: dest=${input.current.dest}, checkin=${input.current.checkin}, nights=${input.current.nights}, notes=${JSON.stringify(input.current.notes)}`,
    historyLines ? `Prior turns:\n${historyLines}` : "",
    `Latest request (via ${input.source}): ${input.text}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const response = await anthropic.messages.parse({
    model: "claude-sonnet-5",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    output_config: {
      format: zodOutputFormat(InterpretQueryResultSchema),
      effort: "low",
    },
    messages: [{ role: "user", content: userTurn }],
  });

  const result = response.parsed_output;
  if (!result) {
    return {
      intent: { dest: null, checkin: null, nights: null, notes: "" },
      clientFilter: { category: null, sort: null },
      unmet: [],
      assistantReply: "",
      clarifyingQuestion: "I didn't quite catch that -- could you rephrase?",
    };
  }

  // The LLM's destination guess is not trusted blindly -- validate against
  // the same resolver searchStays() uses, so a bad guess asks rather than
  // silently 404ing (or falling back to NYC, per page.tsx's default).
  if (result.intent.dest && !resolveDest(result.intent.dest)) {
    return {
      ...result,
      intent: { ...result.intent, dest: null },
      clarifyingQuestion:
        result.clarifyingQuestion ??
        `I don't have inventory for "${result.intent.dest}" yet -- could you try a nearby city?`,
    };
  }

  return result;
}
