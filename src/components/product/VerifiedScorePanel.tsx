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
export default function VerifiedScorePanel({ scores }: { scores: VerifiedScore }) {
  const { total, explanation } = scores;

  return (
    <section className="panel" style={{ padding: 20 }}>
      <h2 style={{ fontSize: 15, marginBottom: 4 }}>
        Agent-readiness{' '}
        <span className="chip" style={{ marginLeft: 8, color: 'var(--accent-green)', borderColor: 'rgba(67, 217, 163, 0.3)' }}>
          verified
        </span>
      </h2>
      <p style={{ color: 'var(--fg-mute)', fontSize: 12.5, marginBottom: 16 }}>
        Computed from live probes run against the real API — this is the earned Agent-Ready Score,
        not a static estimate.
      </p>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 16 }}>
        <span className="mono" style={{ fontSize: 32, fontWeight: 600, color: 'var(--accent-green)' }}>
          {total}
        </span>
        <span style={{ color: 'var(--fg-mute)', fontSize: 13 }}>/ 100 · verified</span>
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
