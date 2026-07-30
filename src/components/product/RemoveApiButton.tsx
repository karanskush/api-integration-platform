'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// Two-step inline confirm rather than a browser dialog: the second click
// happens next to the words saying what dies with the row. Deletion is
// permanent — the endpoint cascades through versions, scores, credentials,
// and the MCP server.
export default function RemoveApiButton({ slug, name }: { slug: string; name: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/apis/${encodeURIComponent(slug)}`, { method: 'DELETE' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          response.status === 429
            ? 'Rate limit reached. Try again in a few minutes.'
            : typeof data.error === 'string'
              ? data.error
              : `Remove failed (${response.status}).`,
        );
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Remove failed.');
      setBusy(false);
      setConfirming(false);
    }
  };

  if (!confirming) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        {error && (
          <span role="alert" style={{ color: 'var(--accent-red)', fontSize: 12 }}>
            {error}
          </span>
        )}
        <button type="button" className="btn" style={{ color: 'var(--accent-red)' }} onClick={() => setConfirming(true)}>
          Remove
        </button>
      </span>
    );
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span style={{ color: 'var(--fg-dim)', fontSize: 12.5 }}>
        Delete {name} — page, MCP server, history? This cannot be undone.
      </span>
      <button
        type="button"
        className="btn"
        style={{ color: 'var(--accent-red)', borderColor: 'rgba(255, 92, 92, 0.4)' }}
        disabled={busy}
        onClick={remove}
      >
        {busy ? 'Removing…' : 'Delete forever'}
      </button>
      <button type="button" className="btn" disabled={busy} onClick={() => setConfirming(false)}>
        Keep it
      </button>
    </span>
  );
}
