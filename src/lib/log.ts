// One log line, one JSON object, in the shape Cloud Logging reads (NOS-69).
//
// WHAT WAS WRONG. Three lines in this app were structured and twenty-one were
// `[tag] free text`. Monitoring can only see what a line says in a FIELD: a
// log-based metric filters on `jsonPayload.something="value"`, so a free-text
// line cannot be counted, cannot be alerted on, and cannot carry the thing an
// operator needs to join it to anything else. NOS-56 - telling a person that a
// guest may have been charged with no booking - had nothing to key on.
//
// THE FIELDS ARE TOP-LEVEL, AND THAT IS NOT A STYLE CHOICE. `infra/envs/uat/
// scheduler.tf` already filters `jsonPayload.event="cron.<job>.completed"` and
// `jsonPayload.via="oidc"`. Nesting a caller's fields under a `data` key would
// leave `sweep_absent` - the alarm watching the only automatic rescue for a
// guest who was charged and never came back - permanently quiet, with every
// test still green. `log-contract.test.ts` reads the Terraform files and fails
// if that link is ever broken, because nothing else would notice.
//
// SEVERITY IS IN THE PAYLOAD, which is the one behaviour change here. Cloud
// Logging infers severity from the stream when the payload does not say: Node
// sends `console.warn` to stderr, so every warning in this app has been arriving
// as ERROR, and a warning and a real error were indistinguishable. A payload
// `severity` overrides that inference. Checked before changing it: no alert
// policy keys on this service's inferred severity (the only `severity>=ERROR`
// filter in `infra/` is scoped to `resource.type="cloud_scheduler_job"`, which
// is Scheduler's own log, not ours).
//
// STILL WRITTEN THROUGH `console`, not `process.stdout`. The stream then agrees
// with the payload for anything that does not parse JSON - a local terminal, a
// test spy, `docker logs` - so an error is on stderr whether or not somebody is
// reading the fields.
//
// NO LEVELS AND NO VERBOSITY SWITCH. Everything written is written. A level a
// deployed copy can be configured with is a way to be missing the line that
// mattered, and there is nothing here noisy enough to need one.
//
// THIS CANNOT THROW. Logging happens in catch blocks, in a sweeper that is
// rescuing a payment, and in a middleware refusal. A logger that can turn a
// handled failure into a crash is worse than a missing line, so every value is
// made serializable before `JSON.stringify` sees it, and the write itself is
// wrapped as well.
import { redactPersonalData } from "./redact";

/**
 * The severities this app emits, which are Cloud Logging's own names.
 *
 * Deliberately four, not Cloud Logging's nine. DEBUG and INFO would be the same
 * thing here, and a severity nobody can describe the meaning of gets used by
 * coin flip.
 *
 * - `INFO` - it happened, and someone may want to count it.
 * - `WARNING` - something is wrong but the request is still being served.
 * - `ERROR` - this request, job or delivery did not do its job.
 * - `CRITICAL` - the process is up and deliberately not serving.
 */
export type Severity = "INFO" | "WARNING" | "ERROR" | "CRITICAL";

/** Fields that land at the top level of the JSON payload, beside `event`. */
export type LogFields = Record<string, unknown>;

/** A line is for reading. Longer than this is a dump, not a message. */
const MAX_STRING_CHARS = 2000;
/** How far into a nested value to go before saying so. */
const MAX_DEPTH = 4;
/** An array in a log line is a sample, not an export. */
const MAX_ARRAY_ITEMS = 50;

/**
 * Build the line. Pure, so a test can read the exact bytes an operator gets.
 *
 * `event` is the stable identifier a filter or metric keys on, dotted and
 * lower-case (`cron.sweep.completed`, `email.send.failed`). Renaming one is a
 * breaking change to whatever watches it - see `log-contract.test.ts`.
 *
 * `message` is the sentence a human reads in the Logs Explorer summary, which
 * shows `jsonPayload.message` and nothing else until a line is expanded. It is
 * written for the person who will be reading it at an unreasonable hour.
 */
export function logLine(
  severity: Severity,
  event: string,
  message: string,
  fields: LogFields = {},
  now: Date = new Date(),
): string {
  // Canonical keys FIRST, so a raw line opens with the severity and the
  // sentence rather than with whatever fields a call site happened to pass -
  // and written AGAIN after them, so a stray `{ message: ... }` cannot displace
  // the one an operator reads or the one a metric filters on. Assigning a key
  // that already exists keeps its original position, so this costs nothing.
  const payload: Record<string, unknown> = { severity, event, message: "", time: "" };
  Object.assign(payload, safeFields(fields));
  payload.severity = severity;
  payload.event = event;
  payload.message = redactPersonalData(clip(message));
  payload.time = now.toISOString();

  try {
    return JSON.stringify(payload);
  } catch {
    // `safeFields` should have made this impossible. If it did not, the line
    // still has to exist and still has to be parseable, because the alternative
    // is a thrown error inside a catch block.
    return JSON.stringify({
      severity: "ERROR",
      event: "log.unserializable",
      message: `A ${event} line could not be serialized, so its fields were dropped.`,
      time: now.toISOString(),
    });
  }
}

export function logInfo(event: string, message: string, fields?: LogFields): void {
  writeLine("INFO", logLine("INFO", event, message, fields));
}

export function logWarning(event: string, message: string, fields?: LogFields): void {
  writeLine("WARNING", logLine("WARNING", event, message, fields));
}

export function logError(event: string, message: string, fields?: LogFields): void {
  writeLine("ERROR", logLine("ERROR", event, message, fields));
}

export function logCritical(event: string, message: string, fields?: LogFields): void {
  writeLine("CRITICAL", logLine("CRITICAL", event, message, fields));
}

/**
 * Write a line that was built separately.
 *
 * For the one caller that needs the line itself as well as the write:
 * `reportFailure` hands the composed line to an injected sink so a test can
 * assert that the guest's reference and the log's reference are the same
 * string. Everything else uses the four helpers above.
 */
export function writeLine(severity: Severity, line: string): void {
  try {
    if (severity === "ERROR" || severity === "CRITICAL") console.error(line);
    else if (severity === "WARNING") console.warn(line);
    else console.info(line);
  } catch {
    // A closed stdout, a patched console, a worker shutting down. Nothing here
    // is worth failing a request for.
  }
}

function clip(text: string): string {
  return text.length > MAX_STRING_CHARS ? `${text.slice(0, MAX_STRING_CHARS)}... [truncated]` : text;
}

function safeFields(fields: LogFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of entriesOf(fields)) {
    const safe = safeValue(value, 0, new Set());
    // `undefined` is dropped rather than written as null: a field that is not
    // there reads as "not applicable", and a null reads as "we know it is null".
    if (safe !== undefined) out[key] = safe;
  }
  return out;
}

/**
 * Anything, turned into something `JSON.stringify` cannot refuse.
 *
 * `ancestors` holds only the values on the path to here, so an object used
 * twice in one line is written twice and only a real cycle is cut.
 */
function safeValue(value: unknown, depth: number, ancestors: Set<object>): unknown {
  if (value === null) return null;

  switch (typeof value) {
    case "string":
      return redactPersonalData(clip(value));
    case "number":
      // NaN and Infinity serialize to `null`, which silently looks like a
      // missing field. Say what it was instead.
      return Number.isFinite(value) ? value : String(value);
    case "boolean":
      return value;
    case "bigint":
      // `JSON.stringify` throws on a bigint. One `holdsExpired: 3n` would
      // otherwise take out the whole line.
      return value.toString();
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
  }

  const object = value as object;
  if (object instanceof Date) return object.toISOString();
  if (object instanceof Error) {
    // Shallow on purpose. The `cause` chain belongs to `describeThrown`
    // (`action-error.ts`), which depends on this module, so this one cannot
    // depend on it. A caller that wants the chain passes it as a string field.
    return redactPersonalData(clip(`${object.name || "Error"}: ${object.message || "(no message)"}`));
  }
  if (ancestors.has(object)) return "[circular]";
  if (depth >= MAX_DEPTH) return "[nested too deep]";

  ancestors.add(object);
  try {
    if (Array.isArray(object)) {
      const items = object.slice(0, MAX_ARRAY_ITEMS).map((item) => safeValue(item, depth + 1, ancestors) ?? null);
      return object.length > MAX_ARRAY_ITEMS
        ? [...items, `[${object.length - MAX_ARRAY_ITEMS} more]`]
        : items;
    }
    const out: Record<string, unknown> = {};
    for (const [key, nested] of entriesOf(object)) {
      const safe = safeValue(nested, depth + 1, ancestors);
      if (safe !== undefined) out[key] = safe;
    }
    return out;
  } finally {
    ancestors.delete(object);
  }
}

/** `Object.entries`, surviving a getter that throws and a hostile prototype. */
function entriesOf(value: object): [string, unknown][] {
  const out: [string, unknown][] = [];
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    return out;
  }
  for (const key of keys) {
    try {
      out.push([key, (value as Record<string, unknown>)[key]]);
    } catch {
      out.push([key, "[threw on read]"]);
    }
  }
  return out;
}
