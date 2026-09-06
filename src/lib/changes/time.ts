// Deterministic UTC formatting for surfaces rendered under ISR.
//
// [slug]/page.tsx, the changelog page, the badge manifest, and the RSS feed are
// all cached for up to an hour, so a relative string ("verified 3 hours ago")
// would freeze at render time and drift from the truth until the next purge.
// An absolute UTC timestamp is correct for as long as the fact it describes is,
// and reads the same in every viewer's timezone — which matters for a document
// that a provider in one country and an integrator in another both cite.

export function formatUtcDate(iso: string | Date | null | undefined): string {
  if (!iso) return 'never';
  const date = iso instanceof Date ? iso : new Date(iso);
  if (!Number.isFinite(date.getTime())) return 'unknown';
  // 'YYYY-MM-DD HH:mm UTC' — minute precision is enough for a changelog and
  // avoids implying that seconds were meaningful.
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
