'use client';

import { useState } from 'react';

type Mode = 'url' | 'paste';

// Deliberately fully async, unlike ImportForm: there is no page to redirect
// to on success — the deep pipeline (doc crawl, LLM enrichment, any human
// clarification) runs in the background, and the only immediate feedback is
// a confirmation that it started. See /api/apis/analyze's own header comment.
export default function AnalyzeForm() {
  const [mode, setMode] = useState<Mode>('url');
  const [values, setValues] = useState<Record<Mode, string>>({ url: '', paste: '' });
  const [docUrls, setDocUrls] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    let value = values[mode].trim();
    if (!value) {
      setError(mode === 'url' ? 'Paste a spec URL first.' : 'Paste a spec first.');
      return;
    }
    if (mode === 'url' && !/^https?:\/\//i.test(value)) {
      if (/^[\w-]+(?:\.[\w-]+)+(?:[/:?#].*)?$/.test(value)) {
        value = `https://${value}`;
        setValues((current) => ({ ...current, url: value }));
      } else {
        setError('That does not look like a URL. Use Paste spec for raw JSON or YAML.');
        return;
      }
    }

    const extraDocs = docUrls
      .split(/[\n,]/)
      .map((u) => u.trim())
      .filter(Boolean);

    setBusy(true);
    try {
      const response = await fetch('/api/apis/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(mode === 'url' ? { url: value } : { text: value }), docUrls: extraDocs }),
        signal: AbortSignal.timeout(45_000),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || typeof data.slug !== 'string') {
        throw new Error(
          response.status === 429
            ? 'Rate limit reached. Try again later.'
            : typeof data.error === 'string'
              ? data.error
              : `Submission failed (${response.status}).`,
        );
      }
      setSubmitted(true);
    } catch (err) {
      const timedOut = err instanceof DOMException && err.name === 'TimeoutError';
      setError(
        timedOut
          ? 'Submission timed out after 45 seconds — the source may be slow or unreachable. Try again.'
          : err instanceof Error
            ? err.message
            : 'Submission failed.',
      );
    } finally {
      setBusy(false);
    }
  };

  if (submitted) {
    return (
      <div className="panel" style={{ padding: 20, display: 'grid', gap: 10 }}>
        <h2 style={{ fontSize: 15 }}>Submitted — we&apos;re on it</h2>
        <p style={{ color: 'var(--fg-dim)', fontSize: 13.5 }}>
          We&apos;re crawling the provider&apos;s docs and running a full field-by-field analysis. This
          takes real time — we&apos;ll email you the moment it&apos;s ready, or sooner if we need you to
          clarify something we couldn&apos;t figure out on our own.
        </p>
        <a className="btn" href="/dashboard" style={{ justifySelf: 'start' }}>
          Back to dashboard
        </a>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="panel import-panel">
      <div className="import-tabs" role="tablist" aria-label="Spec source">
        {(['url', 'paste'] as Mode[]).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            disabled={busy}
            onClick={() => {
              setMode(m);
              setError(null);
            }}
          >
            {m === 'url' ? 'Spec URL' : 'Paste spec'}
          </button>
        ))}
      </div>

      <div className="import-field">
        <label htmlFor="analyze-input">
          {mode === 'url' ? 'OpenAPI, Swagger, or Postman URL' : 'OpenAPI, Swagger, or Postman content'}
        </label>
        {mode === 'url' ? (
          <input
            id="analyze-input"
            type="text"
            inputMode="url"
            autoComplete="url"
            placeholder="https://api.example.com/openapi.json"
            value={values.url}
            disabled={busy}
            onChange={(event) => setValues((current) => ({ ...current, url: event.target.value }))}
          />
        ) : (
          <textarea
            id="analyze-input"
            rows={7}
            spellCheck={false}
            placeholder={'openapi: 3.1.0\ninfo:\n  title: Example API'}
            value={values.paste}
            disabled={busy}
            onChange={(event) => setValues((current) => ({ ...current, paste: event.target.value }))}
          />
        )}
      </div>

      <div className="import-field">
        <label htmlFor="analyze-docs">Extra documentation URLs (optional)</label>
        <textarea
          id="analyze-docs"
          rows={3}
          spellCheck={false}
          placeholder={'https://docs.example.com/guides/orders\nhttps://example.com/changelog'}
          value={docUrls}
          disabled={busy}
          onChange={(event) => setDocUrls(event.target.value)}
        />
        <p style={{ color: 'var(--fg-mute)', fontSize: 12, marginTop: 4 }}>
          One per line. We only follow links on the same domain — this seeds the deep pass, it
          isn&apos;t a general crawler.
        </p>
      </div>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <button className="btn primary btn-block" type="submit" disabled={busy}>
        {busy ? 'Submitting…' : 'Start deep analysis'}
        <span aria-hidden="true">→</span>
      </button>
    </form>
  );
}
