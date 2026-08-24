// The single "Query -> URL" contract. BookingForm's structured-field submit,
// the assistant chat, and voice input all target this one path so the search
// URL is only ever built in one place.
export type Query = { dest: string; checkin: string; nights: number; notes: string };

export function buildSearchUrl(query: Query): string {
  const notesParam = query.notes.trim() ? `&notes=${encodeURIComponent(query.notes.trim())}` : "";
  return `/?dest=${query.dest}&checkin=${query.checkin}&nights=${query.nights}${notesParam}`;
}
