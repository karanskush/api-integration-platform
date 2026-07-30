'use client';

import { useState } from 'react';

type AskResult = { answer: string; toolCalls: Array<{ tool: string; input: unknown }>; steps: number };

// Same busy/error/fetch shape as RunVerificationButton.tsx. Unlike that
// component this isn't owner-gated:
//  - on a claimed page (default endpoint), /api/apis/[slug]/ask authorizes
//    any signed-in user who can view the page (private still requires
//    membership), so [slug]/page.tsx renders this for every signed-in
//    visitor, not just the claiming org.
//  - on the anonymous instant-preview page, `endpoint` is passed as
//    /api/p/[id]/ask instead — no sign-in, no plan, bounded by a hard
//    per-paste + per-IP quota server-side rather than an auth gate.
export default function AskAssistant({
  slug,
  endpoint,
  subtitle,
}: {
  slug: string;
  endpoint?: string;
  subtitle?: string;
}) {
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AskResult | null>(null);

  const ask = async () => {
    if (!question.trim()) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(endpoint ?? `/api/apis/${slug}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'The assistant could not answer that question.');
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The assistant could not answer that question.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel" style={{ padding: 20, display: 'grid', gap: 12 }}>
      <h2 style={{ fontSize: 15 }}>Ask this API</h2>
      <p style={{ color: 'var(--fg-mute)', fontSize: 12.5 }}>
        {subtitle ??
          'Ask in plain language — "where does the customer id come from?", "what can I send to create an order?". Answers are grounded in this API\'s own spec, not general knowledge.'}
      </p>
      <textarea
        aria-label="Question about this API"
        placeholder="Where does this username come from?"
        rows={2}
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) ask();
        }}
        disabled={busy}
        style={{ resize: 'vertical' }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button type="button" className="btn primary" onClick={ask} disabled={busy || !question.trim()}>
          {busy ? 'Thinking…' : 'Ask'}
        </button>
        {error && <span style={{ color: 'var(--accent-red)', fontSize: 12 }}>{error}</span>}
      </div>
      {result && (
        <div style={{ display: 'grid', gap: 8, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          <p style={{ fontSize: 13.5, whiteSpace: 'pre-wrap' }}>{result.answer}</p>
          {result.toolCalls.length > 0 && (
            <p className="mono" style={{ color: 'var(--fg-dim)', fontSize: 11 }}>
              checked: {result.toolCalls.map((c) => c.tool.replace(/^docentapi_/, '')).join(', ')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
