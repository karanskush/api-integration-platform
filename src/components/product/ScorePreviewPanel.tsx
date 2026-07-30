import { scorePreview } from '@/lib/scorePreview';
import type { ImportRecord } from '@/lib/ir';

// Static preview only — no live probing has happened. Deliberately styled in
// calibration cyan, never the "earned" verified green, so this can never be
// mistaken for the real Agent-Ready Score (Phase 2, live verification).
export default function ScorePreviewPanel({ record }: { record: ImportRecord }) {
  const { total, checks } = scorePreview(record);

  return (
    <section className="panel" style={{ padding: 20 }}>
      <h2 style={{ fontSize: 15, marginBottom: 4 }}>
        Agent-readiness <span className="chip" style={{ marginLeft: 8 }}>static preview</span>
      </h2>
      <p style={{ color: 'var(--fg-mute)', fontSize: 12.5, marginBottom: 16 }}>
        Computed from the spec alone — no live requests were made. The full, verified Agent-Ready
        Score requires running probes against your API.
      </p>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 16 }}>
        <span className="mono" style={{ fontSize: 32, fontWeight: 600, color: 'var(--accent)' }}>
          {total}
        </span>
        <span style={{ color: 'var(--fg-mute)', fontSize: 13 }}>/ 100 · static preview</span>
      </div>

      <ul style={{ display: 'grid', gap: 10, listStyle: 'none', padding: 0, margin: 0 }}>
        {checks.map((c) => (
          <li key={c.id} style={{ display: 'grid', gap: 2 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}>
              <span style={{ color: 'var(--fg)' }}>{c.label}</span>
              <span className="mono" style={{ color: 'var(--fg-dim)' }}>
                {c.points}/{c.maxPoints}
              </span>
            </div>
            <p style={{ color: 'var(--fg-mute)', fontSize: 12 }}>{c.message}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
