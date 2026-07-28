// Validating a submitted answer against the question it answers.
//
// The answer route previously took whatever `answer` value the client sent and
// wrote it, unvalidated, into a jsonb column that analyze-finalize then reads to
// decide what the published spec claims about the API. The client, not the
// question, defined what an answer meant.
//
// So a choice is resolved against the option set stored on the row at the time
// the question was asked. Option TEXT never round-trips through the browser —
// only the stable value does — which also means that when an LLM pass eventually
// contributes option labels, none of that model-influenced text is something a
// client can echo back at us.

import { asData } from '../advisor/types';
import type { AnswerSpec } from './archetypes';

export type AnswerEntry = { choice?: unknown; other?: unknown; values?: unknown };
export type ResolvedAnswer = { answer: unknown } | { reason: string };

export const MAX_OTHER_CHARS = 400;
export const MAX_VALUE_PAIRS = 20;
const MAX_MEANING_CHARS = 200;
const MAX_CODE_CHARS = 80;

export function resolveAnswer(spec: AnswerSpec | null, entry: AnswerEntry): ResolvedAnswer {
  // Exactly one mode. Accepting several would leave it to write-order which one
  // wins, and the loser would be silently discarded.
  const modes = [entry.choice !== undefined, entry.other !== undefined, entry.values !== undefined].filter(Boolean);
  if (modes.length !== 1) return { reason: 'Provide exactly one of choice, other or values' };

  if (entry.choice !== undefined) {
    if (typeof entry.choice !== 'string') return { reason: 'choice must be a string' };
    if (!spec) return { reason: 'This question has no recorded options to choose from' };
    if (!spec.options.some((o) => o.value === entry.choice)) return { reason: 'choice is not one of this question’s options' };
    return { answer: entry.choice };
  }

  if (entry.other !== undefined) {
    if (typeof entry.other !== 'string') return { reason: 'other must be a string' };
    if (spec && spec.allowOther === false) return { reason: 'This question does not accept a free-text answer' };
    // Sanitized here rather than at render: this string ends up in the enriched
    // spec artifact that other tools parse, so the boundary that matters is the
    // write, not the page.
    const text = asData(entry.other, MAX_OTHER_CHARS);
    if (!text) return { reason: 'other cannot be empty' };
    return { answer: { other: text } };
  }

  if (!Array.isArray(entry.values)) return { reason: 'values must be an array' };
  if (!entry.values.length) return { reason: 'values cannot be empty' };
  if (entry.values.length > MAX_VALUE_PAIRS) return { reason: `values cannot exceed ${MAX_VALUE_PAIRS} entries` };

  const pairs: Array<{ value: string; meaning: string }> = [];
  for (const raw of entry.values) {
    if (typeof raw !== 'object' || raw === null) return { reason: 'each value entry must be an object' };
    const pair = raw as { value?: unknown; meaning?: unknown };
    if (typeof pair.value !== 'string' && typeof pair.value !== 'number') {
      return { reason: 'each value entry needs a scalar value' };
    }
    const meaning = asData(typeof pair.meaning === 'string' ? pair.meaning : '', MAX_MEANING_CHARS);
    if (!meaning) return { reason: 'each value entry needs a meaning' };
    pairs.push({ value: asData(String(pair.value), MAX_CODE_CHARS), meaning });
  }
  return { answer: { values: pairs } };
}
