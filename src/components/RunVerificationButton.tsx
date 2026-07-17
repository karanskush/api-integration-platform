'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

// Mirrors ManageBillingButton.tsx's busy/error/fetch pattern. Rendered by
// [slug]/page.tsx only for a signed-in member of the owning org on a
// claimed API — the route itself re-checks both, this is just the button.
export default function RunVerificationButton({ slug, authRequired }: { slug: string; authRequired: boolean }) {
  const router = useRouter();
  const [upstreamKey, setUpstreamKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    setTotal(null);
    try {
      const res = await fetch(`/api/apis/${slug}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(upstreamKey ? { upstreamKey } : {}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Verification run failed');
      setTotal(data.total);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification run failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel" style={{ padding: 20, display: 'grid', gap: 12 }}>
      <h2 style={{ fontSize: 15 }}>Run verification</h2>
      <p style={{ color: 'var(--fg-mute)', fontSize: 12.5 }}>
        Runs live probes against this API to earn the verified Agent-Ready Score. One run per hour.
      </p>
      {authRequired && (
        <div>
          <label htmlFor="verify-key">Upstream API key (used once, not stored)</label>
          <input
            id="verify-key"
            type="password"
            placeholder="paste key / token"
            value={upstreamKey}
            onChange={(e) => setUpstreamKey(e.target.value)}
            autoComplete="off"
          />
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button type="button" className="btn primary" onClick={run} disabled={busy}>
          {busy ? 'Verifying…' : 'Run verification'}
        </button>
        {total != null && (
          <span className="mono" style={{ color: 'var(--accent-green)', fontSize: 13 }}>
            Scored {total}/100
          </span>
        )}
        {error && <span style={{ color: 'var(--accent-red)', fontSize: 12 }}>{error}</span>}
      </div>
    </div>
  );
}
