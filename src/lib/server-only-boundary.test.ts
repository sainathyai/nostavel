import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// Convention under test: docs/conventions.md §2 ("`server-only` is a real
// boundary") and .agents/rules/backend.md ("Server boundary") — every module
// in src/lib that handles a secret starts with `import "server-only";`
// before any other import. This is threat-model gap G4 in
// docs/security/webhook-liteapi.md (T15/G4): `webhook-auth.ts` uses
// node:crypto and compares a shared secret, but doesn't import server-only,
// so a bundler misconfiguration could in principle pull it into a client
// bundle.
//
// HOW THE MODULE SET IS DERIVED, AND WHY NOT FOUR HARDCODED PATHS.
//
// Hardcoding the four paths named in the ticket would make this test blind
// to the next module that starts handling a secret — exactly the kind of gap
// that let webhook-auth.ts ship without the import in the first place. So
// this scans every non-test .ts file under src/lib for source-level signals
// that it is handling a secret used to prove or sign an identity or
// credential (as opposed to an arbitrary environment variable):
//
//   1. reads one of the app's signing/shared secrets from process.env
//      (AUTH_SECRET, NEXTAUTH_SECRET, LITEAPI_WEBHOOK_SECRET, CRON_SECRET);
//   2. performs constant-time comparison or HMAC signing (timingSafeEqual,
//      createHmac, crypto.subtle.importKey/.sign) — the pattern
//      .agents/rules/security.md requires for comparing a secret at all
//      ("Compare secrets in constant time... never use === on a secret"); or
//   3. imports the NextAuth config (`@/auth`) to resolve the current
//      session, which is itself backed by AUTH_SECRET — this is how
//      dal.ts qualifies without touching process.env or node:crypto
//      directly.
//
// Verified by grepping src/lib (2026-09-21, recursively, including
// src/lib/assistant/**): this signal set matches exactly quote-token.ts,
// guest-verify.ts, dal.ts and webhook-auth.ts — the four modules named in
// the ticket — and nothing else in src/lib today.
//
// WHAT THIS DOES NOT CATCH, ON PURPOSE VS. AS A KNOWN GAP.
//
// - src/lib/email.ts reads RESEND_API_KEY from process.env and sends it as a
//   bearer token to Resend. That is also a secret by the letter of §2, and
//   email.ts does NOT currently start with `import "server-only"` either —
//   but it matches none of the three signals above (no signing-secret env
//   var name, no constant-time/HMAC primitive, no @/auth import). This is a
//   real, separate gap outside T15/G4 and this ticket's scope (NOS-15 /
//   NOS-17 is the webhook-auth server boundary specifically). Flagging it
//   here rather than silently widening this test past what was asked, or
//   silently ignoring it: a follow-up ticket should cover "any module
//   reading a *_API_KEY or *_SECRET from process.env", which would need a
//   broader (and more false-positive-prone) signal than the one used here.
// - A secret handled only via a value passed in as a function argument
//   (never read from process.env or node:crypto in the module itself) can't
//   be seen by static scanning at all. That is a limit of this whole
//   approach, not just this test, and needs a human in review.
//
// The "finds the secret-handling modules" test below guards the scan itself:
// if a refactor makes the signal stop matching one of the four known
// modules, that test fails loudly instead of the compliance tests silently
// passing over an empty list.

const LIB_DIR = __dirname; // this file lives at src/lib/server-only-boundary.test.ts

const SECRET_ENV_VARS = ["AUTH_SECRET", "NEXTAUTH_SECRET", "LITEAPI_WEBHOOK_SECRET", "CRON_SECRET"];

const SECRET_SIGNAL = new RegExp(
  String.raw`process\.env\.(${SECRET_ENV_VARS.join("|")})\b` +
    String.raw`|timingSafeEqual` +
    String.raw`|createHmac` +
    String.raw`|crypto\.subtle\.(importKey|sign)\(` +
    String.raw`|from\s+["']@/auth["']`,
);

type Dirent = { name: string; parentPath: string; isFile(): boolean };

function listLibFiles(): string[] {
  const entries = readdirSync(LIB_DIR, { recursive: true, withFileTypes: true }) as unknown as Dirent[];
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts"))
    .map((e) => join(e.parentPath, e.name));
}

function secretHandlingModules(): string[] {
  return listLibFiles()
    .filter((f) => SECRET_SIGNAL.test(readFileSync(f, "utf8")))
    .sort();
}

/**
 * Strip a leading BOM and any comments at the very start of the file, so the
 * check looks at the first real statement rather than a doc comment above
 * it. Only the head of the file is touched — comments interleaved *after*
 * the first import (as in quote-token.ts, where a long explanatory comment
 * follows the two imports) are left alone.
 */
function stripLeadingComments(src: string): string {
  let s = src.replace(/^﻿/, "");
  for (;;) {
    const trimmed = s.replace(/^\s+/, "");
    if (trimmed.startsWith("//")) {
      const nl = trimmed.indexOf("\n");
      s = nl === -1 ? "" : trimmed.slice(nl + 1);
      continue;
    }
    if (trimmed.startsWith("/*")) {
      const end = trimmed.indexOf("*/");
      s = end === -1 ? "" : trimmed.slice(end + 2);
      continue;
    }
    s = trimmed;
    break;
  }
  return s;
}

function firstStatement(src: string): string {
  const stripped = stripLeadingComments(src);
  const line = stripped.split("\n", 1)[0] ?? "";
  return line.trim() || "(empty file)";
}

const SERVER_ONLY_FIRST = /^import\s+["']server-only["'];?/;
const SERVER_ONLY_ANYWHERE = /import\s+["']server-only["']/;

describe("server-only boundary (docs/conventions.md §2, T15/G4)", () => {
  const modules = secretHandlingModules();

  it("finds the secret-handling modules the boundary applies to", () => {
    const names = modules.map((f) => relative(LIB_DIR, f).replace(/\\/g, "/"));
    expect(names).toEqual(["dal.ts", "guest-verify.ts", "quote-token.ts", "webhook-auth.ts"]);
  });

  for (const file of modules) {
    const relPath = "src/lib/" + relative(LIB_DIR, file).replace(/\\/g, "/");

    it(`${relPath} starts with import "server-only" before any other import`, () => {
      const src = readFileSync(file, "utf8");
      const stripped = stripLeadingComments(src);

      if (SERVER_ONLY_FIRST.test(stripped)) {
        // Compliant: nothing further to assert.
        return;
      }

      const importsItLater = SERVER_ONLY_ANYWHERE.test(stripped);
      const reason = importsItLater
        ? `imports "server-only" after another import — it must be the first import in the file`
        : `is missing import "server-only" — this module reads a signing secret, ` +
          `performs constant-time/HMAC verification, or resolves session identity, ` +
          `and docs/conventions.md §2 requires "import \\"server-only\\";" before any other import`;

      expect.fail(`${relPath} ${reason}. First statement found: ${firstStatement(src)}`);
    });
  }
});
