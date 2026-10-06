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
export async function register() {
  // `register` is called in every runtime; this file reads process.env and
  // nothing else, but the import below pulls in a module tree that has no
  // business being evaluated on an edge runtime.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { appEnv, configProblems, fatalProblems, supplierMode } = await import("./lib/deploy-config");

  const env = appEnv(process.env);
  const sha = (process.env.APP_SHA ?? "").trim() || "unknown";
  console.log(`[startup] env=${env} commit=${sha} supplier=${supplierMode(process.env)}`);

  const problems = configProblems(process.env);
  for (const problem of problems) {
    const line = `[startup] ${problem.severity}: ${problem.code} - ${problem.message}`;
    if (problem.severity === "fatal") console.error(line);
    else console.warn(line);
  }

  // Asked for rather than filtered here, so "what counts as fatal" has exactly
  // one definition (src/lib/deploy-config.ts) and this file cannot drift from it.
  const fatal = fatalProblems(process.env);
  if (fatal.length > 0) {
    // Unmissable on purpose: this is the state where the app is up, listening,
    // and deliberately serving nothing. Without this line, the only symptom is
    // a 503 with no explanation in it (src/proxy.ts keeps the detail out of the
    // response body, because the response goes to whoever knocked).
    console.error(
      `[startup] NOT SERVING REQUESTS. ${fatal.length} fatal configuration problem(s): ` +
        fatal.map((p) => p.code).join(", ") +
        ". Every path except /api/health will answer 503 until they are fixed.",
    );
  }
}
