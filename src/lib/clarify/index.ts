// Bridges a raised question to its answer space.
//
// archetypes.ts classifies one (action, field, producers) triple. This resolves
// those three from a question that only names a tool and a field path, which is
// all the enrichment pass and the reconciler carry.

import { fieldMapFor } from '../fieldMap';
import type { ImportRecord } from '../ir';
import { lineageFor, producersFor } from '../lineage';
import type { OpenQuestionKind } from '../deepEnrich';
import { classify, type Classification } from './archetypes';
import { buildEnvelopes } from './evidence';

export * from './archetypes';
export * from './answers';
export * from './evidence';
export * from './triage';
export * from './synthesize';

export type QuestionRef = {
  tool: string;
  fieldPath?: string;
  kind: OpenQuestionKind;
};

// A stable handle for a question before it has a database row. Triage and
// synthesis both need to name questions in a prompt and match verdicts back
// afterwards, and the row's uuid does not exist until the insert. Clustering has
// already deduped by (tool, field), so this is unique within a batch.
export function questionHandle(q: { tool: string; fieldPath?: string }): string {
  return `${q.tool} ${q.fieldPath ?? ''}`;
}

// Everything a model may read about one question: the field's own description,
// its siblings on the same operation, the operation's description, and any
// crawled provider docs. Each piece is named so a verdict can cite exactly one
// and be checked against it alone.
export function evidenceForQuestion(
  record: ImportRecord,
  q: QuestionRef,
  docs: Array<{ url: string; title?: string; excerpt: string }>,
) {
  const action = record.actions.find((a) => a.name === q.tool);
  if (!action || !q.fieldPath) return [];

  const map = fieldMapFor(action);
  const field = map.request.find((f) => f.path === q.fieldPath);
  if (!field) return [];

  return buildEnvelopes({
    ...(field.description ? { fieldDescription: field.description } : {}),
    ...(action.description ? { actionDescription: action.description } : {}),
    siblingDescriptions: map.request
      .filter((f) => f.path !== field.path && f.description)
      .slice(0, 8)
      .map((f) => ({ field: f.path, description: f.description! })),
    docs,
  });
}

// Returns null when the question names something that is not in the record —
// an unknown operation, or a field path that does not exist on it. The
// enrichment pass already refuses to emit those, so a null here means the
// question came from somewhere that skipped that check, and it should not be
// given an answer space rather than being given a guessed one.
export function classifyQuestion(record: ImportRecord, q: QuestionRef): Classification | null {
  const action = record.actions.find((a) => a.name === q.tool);
  if (!action || !q.fieldPath) return null;

  const field = fieldMapFor(action).request.find((f) => f.path === q.fieldPath);
  if (!field) return null;

  const producers = producersFor(lineageFor(record), action.name, field.path);
  return classify(action, field, producers, q.kind);
}
