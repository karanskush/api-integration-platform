'use client';

import { useState } from 'react';

export type ClarificationQuestion = {
  id: string;
  question: string;
  options?: string[];
  fieldPath?: string;
};

export default function ClarificationForm({
  slug,
  token,
  questions,
}: {
  slug: string;
  token?: string;
  questions: ClarificationQuestion[];
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    const answers = questions
      .filter((q) => values[q.id]?.trim())
      .map((q) => ({ clarificationId: q.id, answer: values[q.id].trim() }));
    if (!answers.length) {
      setError('Answer at least one question before submitting.');
      return;
    }

    setBusy(true);
    try {
      const url = `/api/apis/${slug}/clarifications${token ? `?token=${encodeURIComponent(token)}` : ''}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof data.error === 'string' ? data.error : `Submission failed (${response.status}).`);
      }
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submission failed.');
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="panel" style={{ padding: 20 }}>
        <p style={{ color: 'var(--fg-dim)' }}>
          Thanks — your answers are saved. If that resolved everything, we&apos;ll email you shortly with the
          finished result.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="panel" style={{ padding: 20, display: 'grid', gap: 16 }}>
      {questions.map((q) => (
        <div key={q.id} style={{ display: 'grid', gap: 6 }}>
          <label htmlFor={`clarification-${q.id}`} style={{ fontSize: 13.5 }}>
            {q.question}
            {q.fieldPath && (
              <code className="mono" style={{ marginLeft: 8, color: 'var(--fg-mute)', fontSize: 11.5 }}>
                {q.fieldPath}
              </code>
            )}
          </label>
          {q.options?.length ? (
            <select
              id={`clarification-${q.id}`}
              value={values[q.id] ?? ''}
              disabled={busy}
              onChange={(event) => setValues((current) => ({ ...current, [q.id]: event.target.value }))}
            >
              <option value="">Choose one…</option>
              {q.options.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          ) : (
            <input
              id={`clarification-${q.id}`}
              type="text"
              value={values[q.id] ?? ''}
              disabled={busy}
              onChange={(event) => setValues((current) => ({ ...current, [q.id]: event.target.value }))}
            />
          )}
        </div>
      ))}

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <button className="btn primary" type="submit" disabled={busy}>
        {busy ? 'Saving…' : 'Save answers'}
      </button>
    </form>
  );
}
