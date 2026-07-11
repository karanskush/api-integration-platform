'use client';

import { useState } from 'react';

export default function ImportForm() {
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const body = text.trim() ? { text } : { url: url.trim() };
    if (!('text' in body) && !url.trim()) {
      setError('Paste a spec URL or the spec itself.');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(45_000),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Import failed (${res.status})`);
      window.location.assign(data.pageUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed.');
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="panel import-panel">
      <div>
        <label htmlFor="spec-url">spec url — openapi / swagger / postman</label>
        <input
          id="spec-url"
          type="url"
          placeholder="https://petstore3.swagger.io/api/v3/openapi.json"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </div>
      <div className="or-divider">— or —</div>
      <div>
        <label htmlFor="spec-text">paste a spec or a curl command</label>
        <textarea
          id="spec-text"
          rows={6}
          placeholder={`curl 'https://api.example.com/v1/users?limit=10' -H 'Authorization: Bearer sk_...'`}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      {/* server-supplied message rendered strictly as React text */}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button className="btn primary btn-block" type="submit" disabled={busy}>
        {busy ? 'Generating…' : 'Generate →'}
      </button>
    </form>
  );
}
