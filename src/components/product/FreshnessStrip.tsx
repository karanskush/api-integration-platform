import Link from 'next/link';
import type { ChangeSummary } from '@/lib/changes/query';
import { formatUtcDate } from '@/lib/changes/time';

// The one line that makes the self-maintaining claim checkable on the page
// itself: when we last looked, what we found, and where to read it.
//
// Absolute UTC dates, not relative ones: this renders under ISR with an hour's
// revalidation, so "3 hours ago" would freeze at render time and quietly drift.
// Same compact panel shape as TtlNotice.
export default function FreshnessStrip({
  slug,
  summary,
  stale,
}: {
  slug: string;
  summary: ChangeSummary;
  stale?: boolean;
}) {
  const { counts30d, total30d, lastCheckedAt, lastChangeAt } = summary;
  const breaking = counts30d.breaking + counts30d.risky;

  return (
    <div
      className="panel"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
        fontSize: 13,
        padding: '10px 16px',
        borderColor: stale ? 'rgba(224, 168, 62, 0.25)' : undefined,
      }}
    >
      <span
        className="mono"
        style={{
          color: stale ? 'var(--warn)' : 'var(--fg-mute)',
          textTransform: 'uppercase',
          fontSize: 11,
          letterSpacing: '0.06em',
        }}
      >
        {stale ? 'stale' : 'watched'}
      </span>

      <span style={{ color: 'var(--fg-dim)' }}>
        Spec last checked {formatUtcDate(lastCheckedAt)}
        {lastChangeAt ? ` · last change ${formatUtcDate(lastChangeAt)}` : ' · no changes recorded yet'}
        {total30d > 0
          ? ` · ${total30d} change${total30d === 1 ? '' : 's'} in 30 days${breaking > 0 ? ` (${breaking} breaking or risky)` : ''}`
          : ''}
      </span>

      <Link href={`/${slug}/changes`} style={{ marginLeft: 'auto', color: 'var(--accent)' }}>
        Changelog →
      </Link>
    </div>
  );
}
