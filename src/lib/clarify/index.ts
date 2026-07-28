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

export * from './archetypes';
export * from './answers';
export * from './evidence';
export * from './triage';

export type QuestionRef = {
  tool: string;
  fieldPath?: string;
  kind: OpenQuestionKind;
};

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
