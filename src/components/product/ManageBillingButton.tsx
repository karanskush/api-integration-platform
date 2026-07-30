'use client';

import { useState } from 'react';

export default function ManageBillingButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/billing/portal', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not open billing portal');
      window.location.href = data.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open billing portal');
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <button type="button" className="btn" onClick={open} disabled={busy}>
        {busy ? 'Opening…' : 'Manage billing'}
      </button>
      {error && <span style={{ color: 'var(--accent-red)', fontSize: 12 }}>{error}</span>}
    </div>
  );
}
