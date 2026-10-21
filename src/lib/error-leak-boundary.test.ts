// Convention under test (NOS-11): nothing under src/app hands a thrown value's
// own text to a caller. `.agents/rules/backend.md`: "`error` is a message safe
// to show a guest. Raw supplier or database messages never reach the browser;
// log the detail on the server instead."
//
// WHY A SOURCE SCAN AND NOT SIX ASSERTIONS ABOUT SIX FILES. The ticket listed
// five call sites, derived by reading four files. Grepping `.message` across
// src/app found NINE, four of which the ticket had not seen - including
// `confirmation/page.tsx`, which renders on the money path and whose sibling
// branches already used static copy. A test naming today's files would be blind
// to the tenth in exactly the way the ticket was blind to the sixth.
//
// So this scans instead, and fails on any NEW use of a thrown value's message
// outside the two places that are deliberate. That makes the allow-list below
// the real content of this test: adding to it is a decision someone has to write
// a reason for.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const APP = join(process.cwd(), "src", "app");

/**
 * Uses of a caught value's text that are allowed, each with the reason.
 *
 * NOT a list of things to get round to. Each of these was read and is correct:
 *
 * - `api/cron/reconcile/route.ts` returns per-booking errors in its response
 *   body. The caller is Cloud Scheduler and the reader is an operator in the
 *   logs; the detail is the entire value of that field. No guest sees it.
 * - `book/[bookingId]/CheckoutClient.tsx` shows the payment provider's own
 *   client-side error to the cardholder. That text is written for cardholders,
 *   never passes through our server, and our own copy would tell the guest less
 *   about their own declined card than "your card was declined" does.
 */
const ALLOWED = new Map<string, string>([
  ["api/cron/reconcile/route.ts", "operator-facing response body, read in logs"],
  ["book/[bookingId]/CheckoutClient.tsx", "payment provider's own message, client-side"],
]);

/**
 * Reading a `.message` off something caught, or off a value typed as an error.
 *
 * Matches the shapes this codebase has actually used:
 *   (e as Error).message      err instanceof Error ? err.message : ...
 *   (err as Error).message    e.message            error.message
 *
 * It deliberately does NOT match `anthropic.messages` or a React prop called
 * `message`, because those are not errors; the identifier has to look like one.
 */
const THROWN_MESSAGE =
  /\b(?:\(\s*(?:e|err|error|cause)\b[^)]*\)|(?:e|err|error|cause))\s*(?:as\s+\w+\s*)?\)?\s*\.message\b/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
    out.push(full);
  }
  return out;
}

/** Every line that reads a thrown value's message, by file. */
function offenders(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of sourceFiles(APP)) {
    const key = relative(APP, file).split("\\").join("/");
    const hits = readFileSync(file, "utf8")
      .split("\n")
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      // A logged detail is the point of this ticket, not a violation of it.
      .filter(({ line }) => !line.startsWith("//") && !line.startsWith("*"))
      .filter(({ line }) => !/console\.(error|warn|log)|reportFailure|describeThrown/.test(line))
      .filter(({ line }) => THROWN_MESSAGE.test(line))
      .map(({ line, n }) => `${n}: ${line}`);
    if (hits.length) found.set(key, hits);
  }
  return found;
}

describe("a thrown value's own text does not reach a caller (NOS-11)", () => {
  it("has no unexplained use of a caught error's message under src/app", () => {
    const unexplained = [...offenders()].filter(([file]) => !ALLOWED.has(file));
    // The failure message has to tell whoever broke this what to do, because
    // the fix is not obvious from a pattern name.
    expect(
      unexplained,
      unexplained.length
        ? `These hand a thrown value's text to a caller. Use reportFailure(scope, e) ` +
            `from src/lib/action-error.ts, which logs the detail and returns safe copy ` +
            `with a reference. If a site is genuinely operator-facing, add it to ALLOWED ` +
            `with the reason.\n` +
            unexplained.map(([f, lines]) => `  ${f}\n    ${lines.join("\n    ")}`).join("\n")
        : "",
    ).toEqual([]);
  });

  it("still finds the deliberate ones, so the scan is not silently broken", () => {
    // A pattern that matches nothing would make the test above pass forever.
    // These two files are known to contain the shape; if the regex stops seeing
    // them, it has stopped working rather than the codebase having got clean.
    const found = offenders();
    for (const allowed of ALLOWED.keys()) {
      expect(found.has(allowed), `${allowed} should still match the scan`).toBe(true);
    }
  });

  it("matches the exact shapes this codebase used to leak", () => {
    const used = [
      'return { ok: false, error: (e as Error).message };',
      'return Response.json({ error: err instanceof Error ? err.message : "fetch failed" });',
      "errorMsg = (e as Error).message;",
      "error = (e as Error).message;",
    ];
    for (const line of used) expect(THROWN_MESSAGE.test(line), line).toBe(true);
  });

  it("does not match things that are not errors", () => {
    const innocent = [
      "const response = await anthropic.messages.parse({",
      "{pb.message}",
      "const message = guestMessage(scope, reference);",
      "expect(lines[0]).toContain(report.reference);",
    ];
    for (const line of innocent) expect(THROWN_MESSAGE.test(line), line).toBe(false);
  });
});
