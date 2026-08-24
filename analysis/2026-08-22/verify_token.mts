// Take the quoteToken the RUNNING server actually put in the page and run it
// through the same guard prepareBookingAction uses. Unit tests prove the logic;
// this proves the deployed wiring produces a token that logic accepts.
import { config } from "dotenv";
config({ path: ".env.local" });

const { Module } = await import("node:module");
const { fileURLToPath } = await import("node:url");
const orig = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (req: string, ...rest: unknown[]) {
  if (req === "server-only") return fileURLToPath(new URL("../2026-08-21/_noop.cjs", import.meta.url));
  return orig.call(this, req, ...rest);
};

const { readQuote, quoteMatchesSession, signQuote } = await import("../../src/lib/quote-token");

const fromPage = process.argv[2];
if (fromPage) {
  console.log("token lifted from the live page:");
  console.log("  tier               ", readQuote(fromPage));
  console.log("  accepted signed-out", quoteMatchesSession(fromPage, false));
  console.log("  accepted as member ", quoteMatchesSession(fromPage, true), "  <- must be false");
}

console.log("\nround trip through this build's own signer:");
const member = signQuote("member");
const pub = signQuote("public");
const rows: [string, boolean, boolean][] = [
  ["member token, member session", quoteMatchesSession(member, true), true],
  ["member token, SIGNED OUT    ", quoteMatchesSession(member, false), false],
  ["public token, signed out    ", quoteMatchesSession(pub, false), true],
  ["public token, member session", quoteMatchesSession(pub, true), false],
  ["garbage token               ", quoteMatchesSession("abc.def", false), false],
  ["no token at all             ", quoteMatchesSession(null, false), false],
];
let bad = 0;
for (const [label, got, want] of rows) {
  const ok = got === want;
  if (!ok) bad++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}  got ${String(got).padEnd(5)} want ${want}`);
}
console.log(bad ? `\n${bad} FAILURES` : "\nall guard directions behave");
