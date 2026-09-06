import type { Severity } from '@/lib/changes/diff';
import type { Release } from '@/lib/changes/query';
import { formatUtcDate } from '@/lib/changes/time';

// Severity carries the meaning here, so it gets the color vocabulary the rest
// of the product already uses: red for "this breaks callers", amber for
// "it might", green for "safe", dim for "prose only".
const SEVERITY_STYLE: Record<Severity, { color: string; border: string; label: string }> = {
  breaking: { color: 'var(--accent-red)', border: 'rgba(232, 93, 93, 0.3)', label: 'breaking' },
  risky: { color: 'var(--warn)', border: 'rgba(224, 168, 62, 0.3)', label: 'risky' },
  additive: { color: 'var(--accent-green)', border: 'rgba(67, 217, 163, 0.3)', label: 'additive' },
  cosmetic: { color: 'var(--fg-mute)', border: 'var(--hair-soft)', label: 'cosmetic' },
};

const SOURCE_LABEL: Record<string, string> = {
  ci_push: 'pushed from CI',
  poll: 'found by scheduled poll',
  manual: 'imported',
  reverify: 'found during re-verification',
  header: 'observed on a live response',
  probe: 'observed by a probe',
};

function SeverityChip({ severity }: { severity: Severity }) {
  const style = SEVERITY_STYLE[severity];
  return (
    <span className="chip" style={{ color: style.color, borderColor: style.border, fontSize: 11 }}>
      {style.label}
    </span>
  );
}

export default function ChangeList({ releases }: { releases: Release[] }) {
  return (
    <div style={{ display: 'grid', gap: 20 }}>
      {releases.map((release) => (
        <section key={release.key} className="panel" style={{ padding: 20 }}>
          <header style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
            <h2 style={{ fontSize: 15 }}>{formatUtcDate(release.observedAt)}</h2>
            {release.specVersionHash && (
              // The version fence, visible: every row below is what changed
              // going INTO this spec version.
              <span className="mono" style={{ color: 'var(--fg-mute)', fontSize: 12 }}>
                spec {release.specVersionHash.slice(0, 12)}
              </span>
            )}
            <span style={{ color: 'var(--fg-mute)', fontSize: 12 }}>
              {release.sources.map((s) => SOURCE_LABEL[s] ?? s).join(', ')}
            </span>
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              {(Object.keys(release.counts) as Severity[])
                .filter((s) => release.counts[s] > 0)
                .map((s) => (
                  <span key={s} className="chip" style={{ color: SEVERITY_STYLE[s].color, borderColor: SEVERITY_STYLE[s].border, fontSize: 11 }}>
                    {release.counts[s]} {SEVERITY_STYLE[s].label}
                  </span>
                ))}
            </span>
          </header>

          <ul style={{ display: 'grid', gap: 10, listStyle: 'none', padding: 0, margin: 0 }}>
            {release.changes.map((change) => (
              <li key={change.id} style={{ display: 'flex', gap: 10, alignItems: 'baseline', fontSize: 13 }}>
                <SeverityChip severity={change.severity} />
                <span style={{ color: 'var(--fg-dim)' }}>
                  {change.summary}
                  {change.tool && (
                    <span className="mono" style={{ color: 'var(--fg-mute)', fontSize: 12, marginLeft: 8 }}>
                      {change.method} {change.path}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
