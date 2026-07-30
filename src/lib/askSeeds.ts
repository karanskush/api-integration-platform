// The questions the empty state offers.
//
// A blank textarea is why nobody discovers what this surface can do: the eight
// advisor tools answer very specific shapes of question, and none of that is
// guessable from a placeholder. So the seeds are derived from THIS API's own
// model — a real endpoint name, a real field — rather than being generic copy.
// "Where does petId come from?" teaches the lineage tool exists; "what do I call
// before add_pet?" teaches the DAG does.
//
// Pure, and computed server-side in the RSC, so the client ships three strings
// rather than the record needed to derive them.

import { fieldMapFor } from './fieldMap';
import type { Action, ImportRecord } from './ir';

export type AskSeed = {
  /** The question, exactly as it will be sent. */
  question: string;
  /** The endpoint it is about, shown as a hint. Null for API-level questions. */
  tool: string | null;
};

const MAX_SEEDS = 3;

// A write is the interesting thing to ask about — it has prerequisites, required
// fields and failure modes, which is where the DAG and the field graph pay off.
// A GET with no parameters teaches nothing.
function mostInterestingWrite(actions: Action[]): Action | null {
  const writes = actions.filter((a) => a.safety === 'write');
  if (!writes.length) return null;
  return writes.reduce((best, a) => {
    const score = (x: Action) => Object.keys((x.paramsSchema?.properties as object) ?? {}).length;
    return score(a) > score(best) ? a : best;
  });
}

// A path parameter is the canonical "where does this come from?" case, because
// it is required, opaque, and the answer is almost never in the docs.
function firstPathParam(actions: Action[]): { field: string; tool: string } | null {
  for (const action of actions) {
    const map = fieldMapFor(action);
    const param = map.request.find((f) => f.location === 'path');
    if (param) return { field: param.path.split('.').pop() ?? param.path, tool: action.name };
  }
  return null;
}

export function suggestedQuestions(record: ImportRecord): AskSeed[] {
  const actions = record.actions ?? [];
  if (!actions.length) return [];

  const seeds: AskSeed[] = [];

  const param = firstPathParam(actions);
  if (param) {
    seeds.push({ question: `Where does ${param.field} come from?`, tool: param.tool });
  }

  const write = mostInterestingWrite(actions);
  if (write) {
    seeds.push({ question: `What do I need to call before ${write.name}?`, tool: write.name });
    if (seeds.length < MAX_SEEDS) {
      seeds.push({ question: `What can I send to ${write.name}?`, tool: write.name });
    }
  }

  // Fallbacks, so an API with only reads still gets a populated empty state.
  if (seeds.length < MAX_SEEDS) {
    const read = actions.find((a) => a.safety === 'read');
    if (read) seeds.push({ question: `What does ${read.name} return?`, tool: read.name });
  }
  if (seeds.length < MAX_SEEDS) {
    seeds.push({ question: 'How do I authenticate with this API?', tool: null });
  }

  return seeds.slice(0, MAX_SEEDS);
}
