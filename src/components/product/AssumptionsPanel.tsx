'use client';

import { useCallback, useState } from 'react';

// Questions triage answered from the provider's own evidence, shown rather than
// silently applied.
//
// This panel is the entire reason triage is allowed to exist. A model that can
// make questions disappear is a model that can be wrong invisibly; a model that
// can only move a question here — with the sentence it relied on, and where that
// sentence came from — can be wrong at a cost of one click. That is also the
// honest ceiling on the evidence gate: a spec that plants "the server always
// overwrites this" will pass every automated check, and the only real defence is
// that the owner reads the quote and disagrees.
//
// So the design brief for this panel is "make disagreeing easy", not "make the
// assumption look credible".

export type PanelAssumption = {
  id: string;
  question: string;
  fieldPath?: string;
  answerLabel: string;
  quote: string;
  sourceKind: string;
  sourceUrl?: string;
};

const SOURCE_LABEL: Record<string, string> = {
  spec_field: 'this field’s own description',
  spec_sibling: 'elsewhere in the spec',
  docs: 'your documentation',
};

export default function AssumptionsPanel({
  slug,
  token,
  assumptions,
}: {
  slug: string;
  token?: string;
  assumptions: PanelAssumption[];
}) {
  const [reopened, setReopened] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reopen = useCallback(
    async (id: string) => {
      setBusy(id);
      setError(null);
      try {
        const url = `/api/apis/${slug}/clarifications${token ? `?token=${encodeURIComponent(token)}` : ''}`;
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ answers: [{ clarificationId: id, reopen: true }] }),
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(typeof data.error === 'string' ? data.error : `Could not reopen (${response.status}).`);
        }
        setReopened((prev) => new Set([...prev, id]));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not reopen.');
      } finally {
        setBusy(null);
      }
    },
    [slug, token],
  );

  const outstanding = assumptions.filter((a) => !reopened.has(a.id));
  if (!assumptions.length) return null;

  return (
    <section className="panel assumptions">
      <header className="assumptions-head">
        <h2 className="assumptions-title">
          We worked {assumptions.length === 1 ? 'one thing' : `${assumptions.length} things`} out from your own docs
        </h2>
        <p className="assumptions-sub">
          Nothing here is blocking. Read the quote and tell us if we got it wrong — that puts the question back to you.
        </p>
      </header>

      <ul className="assumptions-list">
        {outstanding.map((a) => (
          <li className="assumption" key={a.id}>
            <div className="assumption-q">
              {a.question}
              {a.fieldPath && <code className="quiz-field">{a.fieldPath}</code>}
            </div>
            <p className="assumption-answer">
              We recorded: <strong>{a.answerLabel}</strong>
            </p>
            <blockquote className="assumption-quote">
              “{a.quote}”
              <cite>
                — from {SOURCE_LABEL[a.sourceKind] ?? a.sourceKind}
                {/* Rendered as a hostname in plain text, never as a link: a
                    clickable URL built from crawled third-party content is a
                    phishing primitive, and a hostname answers "where did this
                    come from" just as well. */}
                {a.sourceUrl && <span className="assumption-host"> ({hostOf(a.sourceUrl)})</span>}
              </cite>
            </blockquote>
            <button
              type="button"
              className="btn"
              onClick={() => reopen(a.id)}
              disabled={busy === a.id}
            >
              {busy === a.id ? 'Reopening…' : 'That’s not right — ask me'}
            </button>
          </li>
        ))}
      </ul>

      {outstanding.length < assumptions.length && (
        <p className="assumptions-reopened" role="status" aria-live="polite">
          {assumptions.length - outstanding.length} moved back to your questions. Refresh to answer{' '}
          {assumptions.length - outstanding.length === 1 ? 'it' : 'them'}.
        </p>
      )}

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown source';
  }
}
