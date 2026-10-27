// Personal data taken out of text before it reaches a log (NOS-69).
//
// This was private to `action-error.ts` (NOS-11). It moved here because two
// callers need it now - `describeThrown`, and the logger, which redacts every
// string field it writes - and the logger cannot import `action-error.ts`:
// `action-error.ts` logs THROUGH the logger, and two modules that import each
// other at module scope are a bug waiting for someone to reorder an import.

/**
 * Anything that looks like an email address.
 *
 * `.agents/rules/database.md` says guest personal data never goes into logs,
 * and a supplier validation error can quote the value it rejected. An email is
 * the one kind of personal data in these payloads with a shape worth matching.
 *
 * HONEST ABOUT THE LIMIT: this does not catch names or phone numbers, because
 * neither has a shape that can be matched without guessing, and a redactor that
 * silently misses most of what it claims to cover is worse than one with a
 * stated scope. What bounds the rest is the call sites: a thrown message and
 * named fields, never a request or response body.
 */
const EMAIL_SHAPED = /[^\s<>()[\],;:"']+@[^\s<>()[\],;:"']+\.[^\s<>()[\],;:"']+/g;

/** Replace every email-shaped run in `text`. Never throws. */
export function redactPersonalData(text: string): string {
  return text.replace(EMAIL_SHAPED, "[email redacted]");
}
