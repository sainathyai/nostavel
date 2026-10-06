// Runs before every request. Two jobs, in this order:
//
//   1. If this process's configuration is fatally wrong - a LIVE supplier key,
//      a missing secret - refuse everything except /api/health. This is the ONLY
//      layer that enforces that, and deliberately so: refusing at startup
//      instead was measured against the real image and made things worse, since
//      Next keeps listening and answers an empty 500 to everything including
//      the health route (the reasoning is on src/instrumentation.ts). A request
//      that is never served cannot charge a card, which is all this needs to be.
//   2. If this is a shared copy, demand the access password.
//
// The rule itself, including why health comes before configuration and
// configuration before the password, is src/lib/access-gate.ts. This file is
// wiring: pathname in, status code out. Keeping it that way is the direct lesson
// from NOS-5, where two criticals lived in page branches that no test could
// reach.
//
// Next 16 renamed Middleware to Proxy and it now runs on the Node.js runtime by
// default (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md
// §Runtime), which is what makes it legal to use node:crypto's constant-time
// compare here rather than reinventing it against the Edge runtime's Web Crypto.
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requestVerdict } from "@/lib/access-gate";
import { accessGateEnabled, accessPassword, fatalProblems } from "@/lib/deploy-config";
import { verifySharedSecret } from "@/lib/webhook-auth";

const NO_STORE = { "cache-control": "no-store" };

export function proxy(request: NextRequest) {
  const verdict = requestVerdict({
    path: request.nextUrl.pathname,
    // Recomputed per request rather than captured at module load, because it is
    // cheap: a handful of string comparisons.
    //
    // NOT because it makes a correction take effect without a restart. The first
    // draft of this comment claimed that, and the NOS-60 security review pointed
    // out it is false in the direction that matters: src/lib/liteapi.ts captures
    // the supplier key at module load and memoises the payment account it
    // derives from it, so a process whose key is corrected in place would have a
    // gate saying "sandbox, serve" over a client still holding the live one.
    // CORRECTING THE SUPPLIER KEY NEEDS A RESTART.
    fatal: fatalProblems(process.env),
    gateEnabled: accessGateEnabled(process.env),
    authorization: request.headers.get("authorization"),
    password: accessPassword(process.env),
    matches: verifySharedSecret,
  });

  if (verdict.action === "allow") return NextResponse.next();

  if (verdict.action === "unavailable") {
    // Deliberately says nothing about WHICH part of the configuration is wrong.
    // That list names the exact secret a deployed copy is missing, so it goes to
    // the process log (src/instrumentation.ts, once at startup) and to
    // /api/health?deep=1 behind the operations secret — not to whoever knocked.
    return new NextResponse("This environment is not configured correctly and is not serving requests.", {
      status: 503,
      headers: { ...NO_STORE, "content-type": "text/plain; charset=utf-8" },
    });
  }

  // LOGGED, BECAUSE OTHERWISE NOBODY EVER LEARNS IT WAS TRIED. There is no rate
  // limit on this gate yet (NOS-62): the in-memory limiter this repository has
  // is per instance, and on a platform that scales to zero that is close to no
  // limit at all. So the minimum the NOS-60 security review asked for is that a
  // refusal leaves a trace — an unthrottled dictionary attack against a public
  // URL should at least be visible afterwards, and on a per-request billing
  // model it is also a cost worth seeing.
  //
  // The path and a coarse source only. Never the password that was tried, and
  // never the header: both are attacker-controlled text heading for a log, and
  // one of them is a credential guess that may be someone's real password
  // somewhere else.
  const source = (request.headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim() || "unknown";
  console.warn(`[gate] refused ${request.nextUrl.pathname} from ${source}`);

  return new NextResponse("Authentication required.", {
    status: 401,
    headers: {
      ...NO_STORE,
      "content-type": "text/plain; charset=utf-8",
      "www-authenticate": 'Basic realm="Nostavel test environment", charset="UTF-8"',
    },
  });
}

export const config = {
  // Everything, including API routes — the sweeper and the webhook receiver are
  // exempted by the rule (they carry their own secret), not by being invisible
  // here, so that exempting them is a tested decision rather than a regex.
  //
  // Excluded: build output with nothing to protect. A JavaScript bundle from a
  // public repository is already public, and putting a password check in front
  // of every asset buys nothing and costs latency on each one. The HTML that
  // loads them is not excluded, so a stranger gets assets for a page they
  // cannot see.
  //
  // THE TRAILING SLASH IS LOAD-BEARING. Next's own documented example writes
  // this as `_next/static`, which is an unanchored prefix test: measured
  // against the real image, `/_next/staticXYZ` reached the router with NO gate
  // and no fatal-configuration check (404, not 401). Nothing lives at such a
  // path today, so it was never a live bypass - but what is excluded here is
  // excluded from the live-key refusal as well as from the password, so the
  // list has to mean exactly what it says. `favicon.ico` came out of the
  // exclusion altogether: it is one small request, and an exact-match
  // exclusion is a second thing to keep correct for no benefit. Raised as a
  // judgment call by the NOS-60 code review, then confirmed by probe.
  matcher: ["/((?!_next/static/).*)"],
};
