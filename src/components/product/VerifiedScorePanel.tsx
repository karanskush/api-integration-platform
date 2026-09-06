import { formatUtcDate } from '@/lib/changes/time';
import type { VerifiedScore } from '@/lib/persistentApi';

const SUBSCORES: { key: keyof VerifiedScore; label: string }[] = [
  { key: 'authClarity', label: 'Auth clarity' },
  { key: 'errorQuality', label: 'Error quality' },
  { key: 'docDrift', label: 'Doc drift' },
  { key: 'idempotency', label: 'Idempotency' },
];

// Live-probed counterpart to ScorePreviewPanel — same structural layout,
// styled in --accent-green, the "earned" color reserved for verified/success
// only (see globals.css). [slug]/page.tsx renders this instead of
// ScorePreviewPanel once a real scores row exists.
//
// A STALE score (the spec changed after verification) keeps its numbers but
// loses the green: the measurement was real, the contract it measured is not
// the one being served. Rendering it green would be the exact failure the
// version fence exists to prevent.
export default function VerifiedScorePanel({ scores }: { scores: VerifiedScore }) {
  const { total, explanation, stale, verifiedAt } = scores;
  const accent = stale ? 'var(--fg-dim)' : 'var(--accent-green)';

  return (
    <section className="panel" style={{ padding: 20 }}>
      <h2 style={{ fontSize: 15, marginBottom: 4 }}>
        Agent-readiness{' '}
        {stale ? (
          <span className="chip" style={{ marginLeft: 8, color: 'var(--warn)', borderColor: 'rgba(224, 168, 62, 0.35)' }}>
            stale — spec changed since verification
          </span>
        ) : (
          <span className="chip" style={{ marginLeft: 8, color: 'var(--accent-green)', borderColor: 'rgba(67, 217, 163, 0.3)' }}>
            verified
          </span>
        )}
      </h2>
      <p style={{ color: 'var(--fg-mute)', fontSize: 12.5, marginBottom: 16 }}>
        {stale
          ? `Computed from live probes on ${formatUtcDate(verifiedAt)} against a previous spec version. The spec has changed since; these numbers describe the old contract until the next verification run.`
          : `Computed from live probes run against the real API on ${formatUtcDate(verifiedAt)} — this is the earned Agent-Ready Score, not a static estimate.`}
      </p>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 16 }}>
        <span className="mono" style={{ fontSize: 32, fontWeight: 600, color: accent }}>
          {total}
        </span>
        <span style={{ color: 'var(--fg-mute)', fontSize: 13 }}>/ 100 · {stale ? 'previous version' : 'verified'}</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10, marginBottom: 16 }}>
        {SUBSCORES.map(({ key, label }) => {
          const value = scores[key] as number | null;
          return (
            <div key={key} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}>
              <span style={{ color: 'var(--fg)' }}>{label}</span>
              <span className="mono" style={{ color: 'var(--fg-dim)' }}>
                {value == null ? 'n/a' : `${value}/25`}
              </span>
            </div>
          );
        })}
      </div>

      <ul style={{ display: 'grid', gap: 8, listStyle: 'none', padding: 0, margin: 0 }}>
        {explanation.map((e) => (
          <li key={e.factId} style={{ fontSize: 12.5, color: 'var(--fg-dim)' }}>
            {e.message}
          </li>
        ))}
      </ul>
    </section>
  );
}
