'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

// Mirrors ManageBillingButton.tsx's busy/error/fetch pattern. Rendered by
// [slug]/page.tsx only for a signed-in member of the owning org on a
// claimed API — the route itself re-checks both, this is just the button.
//
// Two ways to supply a key. A stored sandbox credential (SandboxCredentialPanel)
// is used when the field below is left empty. A key pasted here is used once
// and never stored, in the environment the owner says it belongs to — that
// choice is what labels every fact the run records.
export default function RunVerificationButton({
  slug,
  authRequired,
  sandboxCredential,
}: {
  slug: string;
  authRequired: boolean;
  sandboxCredential?: { label: string | null; hint: string } | null;
}) {
  const router = useRouter();
  const [upstreamKey, setUpstreamKey] = useState('');
  const [environment, setEnvironment] = useState<'sandbox' | 'production'>('sandbox');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ total: number; environment: string; usedVaultedCredential: boolean } | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`/api/apis/${slug}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(upstreamKey ? { upstreamKey, environment } : {}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Verification run failed');
      setResult({ total: data.total, environment: data.environment ?? 'production', usedVaultedCredential: Boolean(data.usedVaultedCredential) });
      setUpstreamKey('');
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
      {sandboxCredential && (
        <p style={{ color: 'var(--fg-mute)', fontSize: 12.5 }}>
          Using your stored sandbox key{' '}
          <span className="mono">••••{sandboxCredential.hint}</span>
          {sandboxCredential.label ? ` (${sandboxCredential.label})` : ''} — leave the field below empty to use it.
        </p>
      )}
      {authRequired && (
        <div style={{ display: 'grid', gap: 8 }}>
          <label htmlFor="verify-key">Upstream API key (used once, not stored)</label>
          <input
            id="verify-key"
            type="password"
            placeholder="paste key / token"
            value={upstreamKey}
            onChange={(e) => setUpstreamKey(e.target.value)}
            autoComplete="off"
          />
          {upstreamKey && (
            <div style={{ display: 'flex', gap: 14, fontSize: 12.5, flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="radio" name="verify-env" checked={environment === 'sandbox'} onChange={() => setEnvironment('sandbox')} />
                This is a test / sandbox key
              </label>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="radio" name="verify-env" checked={environment === 'production'} onChange={() => setEnvironment('production')} />
                This is a production key
              </label>
            </div>
          )}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button type="button" className="btn primary" onClick={run} disabled={busy}>
          {busy ? 'Verifying…' : 'Run verification'}
        </button>
        {result && (
          <span className="mono" style={{ color: 'var(--accent-green)', fontSize: 13 }}>
            Scored {result.total}/100 ({result.environment}
            {result.usedVaultedCredential ? ', stored key' : ''})
          </span>
        )}
        {error && <span style={{ color: 'var(--accent-red)', fontSize: 12 }}>{error}</span>}
      </div>
    </div>
  );
}
