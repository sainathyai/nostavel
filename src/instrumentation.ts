// Runs once when a server process starts, before it handles any request
// (node_modules/next/dist/docs/01-app/02-guides/instrumentation.md).
//
// Says what this process is, once, in one line - environment, commit, supplier
// mode - and then names every problem with its configuration. When something
// goes wrong on a deployed copy three weeks from now, the first question is
// "which build is this, and was it configured properly", and the answer should
// already be in the log.
//
// WHY THIS DOES NOT REFUSE TO START, HAVING FIRST BEEN WRITTEN TO DO EXACTLY
// THAT. The obvious design is to throw here on a fatal problem, so a copy
// holding a live supplier key never runs at all. Measured against the real
// image (2026-10-06, `docker run` with a non-sandbox key), that is worse in
// every way that matters:
//
//   - Next does not exit. It logs "Failed to prepare server" and keeps
//     listening, answering `500 Internal Server Error` with an empty body to
//     every path.
//   - That includes /api/health. So the one route built to explain a broken
//     deploy stops explaining anything, and the delivery pipeline is left with
//     a 500 and no reason - precisely the state the health route exists to
//     prevent.
//   - The container stays up, so a container platform sees a started revision
//     rather than a failed one.
//
// A refusal that degrades the diagnosis is not a safety feature. The refusal
// lives in src/proxy.ts instead, which answers 503 to every path except
// /api/health, and that is strictly stronger where it counts: a request that is
// never served cannot charge a card, whether or not the process managed to
// start. The health route then reports `ok: false` to anyone and, behind the
// operations secret, exactly which checks failed - which is what the pipeline
// reads before it moves any traffic.
//
// So this function logs, loudly, and nothing here can stop a process serving.
import type { Instrumentation } from "next";
import { pathOnly, reportError } from "./lib/error-report";
import { logCritical, logError, logInfo, logWarning } from "./lib/log";

export async function register() {
  // `register` is called in every runtime; this file reads process.env and
  // nothing else, but the import below pulls in a module tree that has no
  // business being evaluated on an edge runtime.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { appEnv, configProblems, fatalProblems, supplierMode } = await import("./lib/deploy-config");

  const env = appEnv(process.env);
  const sha = (process.env.APP_SHA ?? "").trim() || "unknown";
  const supplier = supplierMode(process.env);
  logInfo("startup.ready", `Started in ${env} on commit ${sha}, supplier ${supplier}.`, {
    env,
    commit: sha,
    supplier,
  });

  const problems = configProblems(process.env);
  for (const problem of problems) {
    const message = `${problem.code} - ${problem.message}`;
    // `{ ...problem }` was the obvious thing to write here and it was wrong: a
    // `ConfigProblem` carries its own `severity` and `message`, and the logger
    // writes the canonical pair last, so both would have been silently dropped.
    // The problem's own severity is already said by ERROR versus WARNING.
    const fields = { code: problem.code, env };
    if (problem.severity === "fatal") logError("startup.config_problem", message, fields);
    else logWarning("startup.config_problem", message, fields);
  }

  // Asked for rather than filtered here, so "what counts as fatal" has exactly
  // one definition (src/lib/deploy-config.ts) and this file cannot drift from it.
  const fatal = fatalProblems(process.env);
  if (fatal.length > 0) {
    // Unmissable on purpose: this is the state where the app is up, listening,
    // and deliberately serving nothing. Without this line, the only symptom is
    // a 503 with no explanation in it (src/proxy.ts keeps the detail out of the
    // response body, because the response goes to whoever knocked).
    logCritical(
      "startup.not_serving",
      `NOT SERVING REQUESTS. ${fatal.length} fatal configuration problem(s): ` +
        fatal.map((p) => p.code).join(", ") +
        ". Every path except /api/health will answer 503 until they are fixed.",
      { env, commit: sha, codes: fatal.map((p) => p.code), count: fatal.length },
    );
  }
}

/**
 * Every server error Next catches for us, reported once (NOS-70).
 *
 * This is the half `reportFailure` cannot reach: a server component that
 * throws, a route handler that throws, a server action nobody wrapped. Without
 * it those are whatever Next printed to stderr, with no group, no count and no
 * first-seen.
 *
 * NO RUNTIME GUARD, unlike `register` above. That one returns early on the edge
 * runtime because it imports a module tree with no business being evaluated
 * there; this one reaches `log.ts`, which is `console` and `JSON.stringify`, and
 * an error on an edge route is exactly as worth reporting as one on a node
 * route.
 *
 * Synchronous on purpose. Next awaits a promise returned from here, so an async
 * reporter would sit in the request's own path; everything this does is one
 * line to stdout.
 */
export const onRequestError: Instrumentation.onRequestError = (error, request, context) => {
  const path = pathOnly(request.path);
  // React can replace the thrown instance while rendering a server component,
  // and then the digest a guest reads on screen is the only thing tying their
  // report to this entry (Next's instrumentation docs). Read defensively: the
  // caught value is `unknown` and may not be an object at all.
  const digest =
    typeof error === "object" && error !== null && "digest" in error
      ? String((error as { digest: unknown }).digest)
      : undefined;

  reportError(
    "request.failed",
    `Unhandled error in ${context.routeType} ${request.method} ${path}.`,
    error,
    { path, method: request.method, routeType: context.routeType, routePath: context.routePath, digest },
  );
};
