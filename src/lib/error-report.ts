// An exception that reaches a place which groups and counts it (NOS-70).
//
// WHAT WAS WRONG. `reportFailure` (NOS-11) writes one findable line per handled
// failure, and NOS-69 made it a line with fields. What neither did is answer
// "is this happening to guests right now, and since when": `grep` is not a
// count, nothing watches the log, and an exception nobody caught was whatever
// Next printed to stderr. The same fault twenty times looked like twenty
// unrelated lines.
//
// WHY THERE IS NO VENDOR HERE. Error Reporting reads Cloud Logging, which
// already has every line this app writes. So grouping, a count, a first-seen
// and a notification cost one `@type` in a payload we were writing anyway: no
// new dependency, no new secret for the owner to paste, no new IAM role, no
// bill. The runtime identity needs `errorreporting.writer` only to call the API
// directly, which this deliberately does not do. If a paid tracker is ever
// wanted, nothing here is in its way.
//
// WHAT MAKES AN ENTRY A REPORT, AND WHAT MUST NOT. Error Reporting captures a
// log entry whose payload is typed as a `ReportedErrorEvent`, or whose message
// carries a stack trace. Both are set here, and NOWHERE ELSE in this app does a
// stack reach a log line - which is the whole of AC 4. A refused password
// (`gate.refused`), a rate-limit denial and an unauthorized cron call are
// logged, some of them at ERROR, and none of them is reported: they are the
// system working. An error channel carrying routine refusals is one nobody
// reads, and the ones here would be the loudest things in it.
import { logError, type LogFields } from "./log";

/**
 * The type url that tells Error Reporting to take an entry even when its
 * message has no parseable stack trace.
 *
 * Documented at cloud.google.com/error-reporting/docs/formatting-error-messages
 * (read 2026-10-28). `v1beta1` is Google's own current spelling for it, not a
 * version we chose.
 */
const REPORTED_ERROR_EVENT = "type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent";

/**
 * Just enough of the environment to read two names from.
 *
 * Not `NodeJS.ProcessEnv`: that type requires `NODE_ENV`, so a test could not
 * pass the two variables this reads without a cast through `unknown`, and a
 * cast in a test is a way to be testing something else.
 */
type Env = Record<string, string | undefined>;

/** What we know about where it happened. Everything is optional; nothing is a header. */
export type ErrorContext = {
  /** The id the guest quotes, so their report finds the group (NOS-11). */
  reference?: string;
  /** Our own name for the failing operation, e.g. a `FailureScope`. */
  scope?: string;
  /** Request path WITHOUT the query string's values. */
  path?: string;
  method?: string;
  /** Next's own words: render, route, action or proxy. */
  routeType?: string;
  /** The route file, e.g. /app/book/[id]. */
  routePath?: string;
  /**
   * React may replace the thrown instance while rendering a server component,
   * and the digest is then the only way to tie a guest's "it said an error
   * occurred, digest 1234" to this entry (Next's own instrumentation docs).
   */
  digest?: string;
};

/**
 * A request path with the query string removed.
 *
 * Next hands `onRequestError` the resource path INCLUDING the query (its own
 * docs: `/blog?name=foo`). Our own URLs carry a guest's email on the booking
 * lookup, so the query cannot go into a log line. Request headers are left out
 * of a report entirely for the same reason, one step worse: they hold the
 * session cookie and the access-gate credential.
 */
export function pathOnly(path: string): string {
  const cut = path.indexOf("?");
  return cut === -1 ? path : path.slice(0, cut);
}

/**
 * Which build this is, which is what AC 2 asks for.
 *
 * `K_SERVICE` is set by Cloud Run itself, so the service name is the platform's
 * own rather than a second copy of it in our configuration. `APP_SHA` is
 * already set on the revision and already logged once at startup.
 */
export function serviceContext(env: Env = process.env): { service: string; version: string } {
  const appEnv = (env.APP_ENV ?? "").trim() || "local";
  return {
    service: (env.K_SERVICE ?? "").trim() || `nostavel-${appEnv}`,
    version: (env.APP_SHA ?? "").trim() || "unknown",
  };
}

/**
 * The stack, if the thrown thing has one. Never throws.
 *
 * `throw "nope"` is legal, a rejected promise can carry no reason at all, and a
 * proxy can throw while being read. All three arrive here.
 */
export function stackOf(thrown: unknown): string | null {
  try {
    if (!(thrown instanceof Error)) return null;
    const stack = thrown.stack;
    return typeof stack === "string" && stack.trim().length > 0 ? stack : null;
  } catch {
    return null;
  }
}

/**
 * The reported message: a human sentence, then the stack.
 *
 * Error Reporting groups by the stack, and the Logs Explorer summary shows only
 * the first line, so this order serves both. The logger truncates a message at
 * 2000 characters; a stack longer than that loses its deepest frames, which are
 * not the ones grouping or a person reads.
 */
export function reportedMessage(headline: string, thrown: unknown): string {
  const stack = stackOf(thrown);
  return stack ? `${headline}\n${stack}` : headline;
}

/**
 * The fields that turn an ordinary ERROR line into a reported error.
 *
 * `event` is used for grouping ONLY when there is no stack: Error Reporting
 * needs something stable to group by, and the alternative is one group per
 * occurrence. `filePath` is honestly "unknown" rather than a file that does not
 * exist, so the group is keyed on the function name, which is the event.
 */
export function reportFields(
  event: string,
  thrown: unknown,
  context: ErrorContext = {},
  env: Env = process.env,
): LogFields {
  const fields: LogFields = {
    "@type": REPORTED_ERROR_EVENT,
    serviceContext: serviceContext(env),
    ...context,
  };
  if (!stackOf(thrown)) {
    fields.context = { reportLocation: { filePath: "unknown", lineNumber: 0, functionName: event } };
  }
  return fields;
}

/**
 * Report an exception. The one call for anything unexpected.
 *
 * Synchronous and incapable of throwing, because the caller is a catch block or
 * Next's own error hook: a reporter that can turn a handled failure into an
 * unhandled one has made things worse. Everything it does is one `logError`,
 * which swallows its own write failures.
 */
export function reportError(event: string, headline: string, thrown: unknown, context: ErrorContext = {}): void {
  try {
    logError(event, reportedMessage(headline, thrown), reportFields(event, thrown, context));
  } catch {
    // Unreachable by construction; here because the promise above is absolute.
  }
}
