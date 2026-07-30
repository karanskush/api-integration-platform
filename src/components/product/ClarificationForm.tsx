'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// One question at a time, with a "show all" escape.
//
// One-at-a-time is what makes "I don't know" cheap to offer: as a checkbox in a
// stacked form, skipping reads as abandonment; as one of two buttons on a
// focused card it reads as an answer. That matters because a question nobody can
// answer used to pin the whole analysis at needs_input forever.
//
// Options are referenced by their stable `value`, never by their label — the
// server resolves a choice against the option set it stored when it asked, so
// nothing the client sends can define what an answer means.

export type QuizOption = {
  value: string;
  label: string;
  detail?: string;
};

export type QuizSuggestion = {
  value: string;
  meaning: string;
  provenance: 'spec' | 'docs' | 'heuristic' | 'model_guess';
  sourceUrl?: string;
};

export type QuizAnswerSpec = {
  kind: 'single_choice' | 'open_values' | 'free_text';
  options: QuizOption[];
  allowOther: boolean;
  why?: string;
  unlocks?: string;
  // Candidate value/meaning pairs proposed for an undocumented code. Pre-filled
  // so the owner confirms or corrects rather than typing from scratch, and never
  // pre-selected — a suggestion is a proposal, not an answer.
  suggestions?: QuizSuggestion[];
};

// What triage concluded, with the sentence it relied on. Shown rather than
// applied silently: the owner decides whether the inference holds.
export type QuizAssumption = {
  answer: string;
  quote: string;
  sourceKind: string;
  sourceUrl?: string;
};

export type ClarificationQuestion = {
  id: string;
  question: string;
  fieldPath?: string;
  answerSpec?: QuizAnswerSpec;
  appliesTo?: Array<{ tool: string; fieldPath: string }>;
  assumption?: QuizAssumption;
};

const OTHER = '__other__';

type Draft =
  | { mode: 'choice'; value: string }
  | { mode: 'other'; text: string }
  | { mode: 'values'; pairs: Array<{ value: string; meaning: string }> };

type Submission =
  | { clarificationId: string; choice: string }
  | { clarificationId: string; other: string }
  | { clarificationId: string; values: Array<{ value: string; meaning: string }> }
  | { clarificationId: string; skip: true };

function toSubmission(id: string, draft: Draft | undefined): Submission | null {
  if (!draft) return null;
  if (draft.mode === 'choice') return draft.value ? { clarificationId: id, choice: draft.value } : null;
  if (draft.mode === 'other') return draft.text.trim() ? { clarificationId: id, other: draft.text.trim() } : null;
  const pairs = draft.pairs.filter((p) => p.value.trim() && p.meaning.trim());
  return pairs.length ? { clarificationId: id, values: pairs } : null;
}

export default function ClarificationForm({
  slug,
  token,
  questions,
}: {
  slug: string;
  token?: string;
  questions: ClarificationQuestion[];
}) {
  const [index, setIndex] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [resolved, setResolved] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const legendRef = useRef<HTMLLegendElement>(null);

  const total = questions.length;
  const done = resolved.size;
  const current = questions[Math.min(index, total - 1)];

  // Move focus to the new question rather than leaving it on a button that
  // just vanished — otherwise a keyboard user is dropped back at the document.
  useEffect(() => {
    if (!showAll) legendRef.current?.focus();
  }, [index, showAll]);

  const send = useCallback(
    async (batch: Submission[]) => {
      if (!batch.length) return;
      setBusy(true);
      setError(null);
      try {
        const url = `/api/apis/${slug}/clarifications${token ? `?token=${encodeURIComponent(token)}` : ''}`;
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ answers: batch }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(typeof data.error === 'string' ? data.error : `Submission failed (${response.status}).`);
        }
        if (Array.isArray(data.rejected) && data.rejected.length) {
          setError(`${data.rejected.length} answer${data.rejected.length === 1 ? '' : 's'} could not be saved. Please check and retry.`);
          return;
        }
        setResolved((prev) => new Set([...prev, ...batch.map((b) => b.clarificationId)]));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Submission failed.');
      } finally {
        setBusy(false);
      }
    },
    [slug, token],
  );

  const advance = useCallback(() => setIndex((i) => Math.min(i + 1, total - 1)), [total]);

  const answerCurrent = useCallback(async () => {
    if (!current) return;
    const submission = toSubmission(current.id, drafts[current.id]);
    if (!submission) {
      setError('Choose an option, or use "I don’t know" to move on.');
      return;
    }
    await send([submission]);
    advance();
  }, [current, drafts, send, advance]);

  const skipCurrent = useCallback(async () => {
    if (!current) return;
    await send([{ clarificationId: current.id, skip: true }]);
    advance();
  }, [current, send, advance]);

  const submitAll = useCallback(async () => {
    const batch = questions
      .filter((q) => !resolved.has(q.id))
      .map((q) => toSubmission(q.id, drafts[q.id]))
      .filter((s): s is Submission => s !== null);
    if (!batch.length) {
      setError('Answer at least one question, or use "I don’t know" on the ones you cannot.');
      return;
    }
    await send(batch);
  }, [questions, drafts, resolved, send]);

  const allResolved = done >= total;

  if (allResolved) {
    return (
      <div className="panel" style={{ padding: 20 }}>
        <p style={{ color: 'var(--fg-dim)' }}>
          Thanks — that’s everything. We’ll rebuild this API’s record with your answers and email you when it’s ready.
        </p>
      </div>
    );
  }

  const visible = showAll ? questions.filter((q) => !resolved.has(q.id)) : current ? [current] : [];

  return (
    <div className="panel quiz">
      <div className="quiz-progress">
        <div className="quiz-progress-meta">
          <span role="status" aria-live="polite">
            {showAll ? `${total - done} left` : `Question ${Math.min(index + 1, total)} of ${total}`}
          </span>
          <button type="button" className="quiz-toggle" onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'One at a time' : 'Show all'}
          </button>
        </div>
        <div className="quiz-progress-track">
          <div className="quiz-progress-fill" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
        </div>
      </div>

      {visible.map((q, i) => (
        <QuestionCard
          key={q.id}
          question={q}
          legendRef={!showAll && i === 0 ? legendRef : undefined}
          draft={drafts[q.id]}
          disabled={busy}
          onChange={(draft) => setDrafts((prev) => ({ ...prev, [q.id]: draft }))}
        />
      ))}

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <div className="quiz-actions">
        {showAll ? (
          <button className="btn primary" type="button" onClick={submitAll} disabled={busy}>
            {busy ? 'Saving…' : 'Save answers'}
          </button>
        ) : (
          <>
            <button className="btn primary" type="button" onClick={answerCurrent} disabled={busy}>
              {busy ? 'Saving…' : 'Answer'}
            </button>
            <button className="btn" type="button" onClick={skipCurrent} disabled={busy}>
              I don’t know
            </button>
            <span className="spacer" />
            {index > 0 && (
              <button className="btn" type="button" onClick={() => setIndex((v) => Math.max(0, v - 1))} disabled={busy}>
                Back
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function QuestionCard({
  question,
  legendRef,
  draft,
  disabled,
  onChange,
}: {
  question: ClarificationQuestion;
  legendRef?: React.RefObject<HTMLLegendElement | null>;
  draft?: Draft;
  disabled: boolean;
  onChange: (draft: Draft) => void;
}) {
  const spec = question.answerSpec;
  const whyId = `why-${question.id}`;
  const sites = question.appliesTo ?? [];

  // A question about a code's meanings is the one space we cannot enumerate, so
  // it is the one place a model proposes candidates. Pre-filled rather than
  // pre-selected: the owner is confirming or correcting, and an untouched
  // suggestion is only submitted because they left it standing.
  const suggested = spec?.suggestions ?? [];
  const seeded = suggested.length
    ? suggested.map((s) => ({ value: s.value, meaning: s.meaning }))
    : [{ value: '', meaning: '' }];
  const pairs = draft?.mode === 'values' ? draft.pairs : seeded;
  const setPairs = (next: Array<{ value: string; meaning: string }>) => onChange({ mode: 'values', pairs: next });

  const selected = draft?.mode === 'choice' ? draft.value : draft?.mode === 'other' ? OTHER : '';

  const describedBy = useMemo(() => (spec?.why || spec?.unlocks ? whyId : undefined), [spec, whyId]);

  return (
    <fieldset className="quiz-card" aria-describedby={describedBy}>
      <legend className="quiz-legend" ref={legendRef} tabIndex={-1}>
        {question.question}
      </legend>

      <div className="quiz-context">
        {question.fieldPath && <code className="quiz-field">{question.fieldPath}</code>}
        {sites.length > 1 && (
          <details className="quiz-sites">
            <summary>Affects {sites.length} operations</summary>
            <ul>
              {sites.map((s) => (
                <li key={`${s.tool} ${s.fieldPath}`}>
                  {s.tool} · {s.fieldPath}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      {(spec?.why || spec?.unlocks) && (
        <div id={whyId}>
          {spec.why && <p className="quiz-why">{spec.why}</p>}
          {spec.unlocks && <p className="quiz-unlocks">{spec.unlocks}</p>}
        </div>
      )}

      {spec?.kind === 'open_values' ? (
        <div className="quiz-pairs">
          {suggested.length > 0 && (
            <p className="quiz-suggested-note">
              {suggested.every((s) => s.provenance === 'model_guess')
                ? 'Suggested from convention — we could not find these documented. Correct anything that is wrong.'
                : 'Suggested from your documentation. Correct anything that is wrong.'}
            </p>
          )}
          {pairs.map((pair, i) => (
            <div className="quiz-pair" key={i}>
              <input
                type="text"
                aria-label={`Value ${i + 1}`}
                placeholder="1"
                value={pair.value}
                disabled={disabled}
                onChange={(e) => setPairs(pairs.map((p, j) => (j === i ? { ...p, value: e.target.value } : p)))}
              />
              <input
                type="text"
                aria-label={`What value ${i + 1} means`}
                placeholder="active"
                value={pair.meaning}
                disabled={disabled}
                onChange={(e) => setPairs(pairs.map((p, j) => (j === i ? { ...p, meaning: e.target.value } : p)))}
              />
              <button type="button" onClick={() => setPairs(pairs.filter((_, j) => j !== i))} disabled={disabled || pairs.length === 1}>
                Remove
              </button>
            </div>
          ))}
          <button type="button" className="btn" onClick={() => setPairs([...pairs, { value: '', meaning: '' }])} disabled={disabled}>
            Add another
          </button>
        </div>
      ) : (
        <div className="quiz-options">
          {(spec?.options ?? []).map((option, i) => (
            <label className="quiz-option" key={option.value}>
              <input
                type="radio"
                name={`q-${question.id}`}
                value={option.value}
                checked={selected === option.value}
                disabled={disabled}
                onChange={() => onChange({ mode: 'choice', value: option.value })}
              />
              <span className="quiz-option-label">
                <span>
                  {option.label}
                  {i < 9 && <kbd className="quiz-key">{i + 1}</kbd>}
                </span>
                {option.detail && <span className="quiz-option-detail">{option.detail}</span>}
              </span>
            </label>
          ))}

          {(spec?.allowOther ?? true) && (
            <>
              <label className="quiz-option">
                <input
                  type="radio"
                  name={`q-${question.id}`}
                  value={OTHER}
                  checked={selected === OTHER}
                  disabled={disabled}
                  onChange={() => onChange({ mode: 'other', text: '' })}
                />
                <span className="quiz-option-label">
                  <span>Something else</span>
                </span>
              </label>
              {selected === OTHER && (
                <div className="quiz-other">
                  <input
                    type="text"
                    autoFocus
                    aria-label="Your answer"
                    placeholder="In your own words…"
                    value={draft?.mode === 'other' ? draft.text : ''}
                    disabled={disabled}
                    onChange={(e) => onChange({ mode: 'other', text: e.target.value })}
                  />
                </div>
              )}
            </>
          )}
        </div>
      )}
    </fieldset>
  );
}
