'use client';

import { useState } from 'react';

// Rendered by /p/[id] only when Clerk+Postgres are configured and the
// viewer is signed in (checked server-side in the page) — this component
// itself only handles the claim request and its result state.
export default function ClaimBanner({ ephemeralId }: { ephemeralId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pageUrl, setPageUrl] = useState<string | null>(null);

  const claim = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/apis/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ephemeralId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save this API');
      setPageUrl(data.pageUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save this API');
    } finally {
      setBusy(false);
    }
  };

  if (pageUrl) {
    return (
      <div className="panel" style={{ padding: '10px 16px', fontSize: 13 }}>
        Saved. This API now lives permanently at{' '}
        <a href={pageUrl} className="text-link">
          {pageUrl}
        </a>
        .
      </div>
    );
  }

  return (
    <div className="panel" style={{ padding: '10px 16px', display: 'flex', gap: 12, alignItems: 'center', fontSize: 13 }}>
      <span style={{ color: 'var(--fg-dim)' }}>Want this page and MCP server to stay up permanently?</span>
      <button type="button" className="btn primary" onClick={claim} disabled={busy} style={{ marginLeft: 'auto' }}>
        {busy ? 'Saving…' : 'Save to my account'}
      </button>
      {error && <p style={{ color: 'var(--accent-red)', margin: 0 }}>{error}</p>}
    </div>
  );
}
