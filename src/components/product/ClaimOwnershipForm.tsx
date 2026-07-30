'use client';

import { useState } from 'react';

type ClaimMethod = 'dns' | 'meta' | 'email';

const METHOD_LABEL: Record<ClaimMethod, string> = {
  dns: 'DNS TXT record',
  meta: 'HTML meta tag',
  email: 'Account email domain',
};

// Rendered by [slug]/page.tsx when claimStatus is "unclaimed" and the viewer
// is signed in — mirrors ClaimBanner.tsx's busy/error/result shape, but two
// steps: start a claim (get instructions), then verify it.
export default function ClaimOwnershipForm({ slug, defaultDomain }: { slug: string; defaultDomain: string }) {
  const [domain, setDomain] = useState(defaultDomain);
  const [method, setMethod] = useState<ClaimMethod>('dns');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claimId, setClaimId] = useState<string | null>(null);
  const [instructions, setInstructions] = useState<string | null>(null);
  const [pageUrl, setPageUrl] = useState<string | null>(null);
  const [retry, setRetry] = useState(false);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/apis/${slug}/claim/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain, method }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not start the claim');
      setClaimId(data.claimId);
      setInstructions(data.instructions);
      setRetry(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the claim');
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    if (!claimId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/apis/${slug}/claim/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claimId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not verify the claim');
      if (data.verified) {
        setPageUrl(data.pageUrl);
        setRetry(false);
      } else {
        setRetry(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not verify the claim');
    } finally {
      setBusy(false);
    }
  };

  if (pageUrl) {
    return (
      <div className="panel" style={{ padding: '10px 16px', fontSize: 13 }}>
        Verified. This page is now yours —{' '}
        <a href={pageUrl} className="text-link">
          reload to see it
        </a>
        .
      </div>
    );
  }

  if (claimId) {
    return (
      <div style={{ display: 'grid', gap: 12 }}>
        <p style={{ color: 'var(--fg-dim)', fontSize: 13 }}>{instructions}</p>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <button type="button" className="btn primary" onClick={verify} disabled={busy}>
            {busy ? 'Verifying…' : 'Verify now'}
          </button>
          {retry && (
            <span style={{ color: 'var(--fg-mute)', fontSize: 12.5 }}>
              Not found yet — this can take a few minutes to propagate. Try again shortly.
            </span>
          )}
        </div>
        {error && <p style={{ color: 'var(--accent-red)', fontSize: 12.5 }}>{error}</p>}
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <label htmlFor="claim-domain">Domain</label>
          <input
            id="claim-domain"
            type="text"
            placeholder="api.example.com"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="claim-method">Verification method</label>
          <select id="claim-method" value={method} onChange={(e) => setMethod(e.target.value as ClaimMethod)}>
            {(Object.keys(METHOD_LABEL) as ClaimMethod[]).map((m) => (
              <option key={m} value={m}>
                {METHOD_LABEL[m]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <button type="button" className="btn primary" onClick={start} disabled={busy || !domain}>
        {busy ? 'Starting…' : 'Start claim'}
      </button>
      {error && <p style={{ color: 'var(--accent-red)', fontSize: 12.5 }}>{error}</p>}
    </div>
  );
}
