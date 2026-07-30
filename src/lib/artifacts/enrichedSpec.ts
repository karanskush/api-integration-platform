// Builds an OpenAPI-shaped document from DocentAPI's own normalized model of
// the API — NOT a byte-for-byte re-annotation of the customer's original
// file. normalize.ts already restructures $refs/oneOf/allOf away during
// import, so there is no clean 1:1 path back onto the original tree; this is
// assembled fresh from the same Action[] everything else in this codebase
// already treats as the source of truth.
//
// Every field carries x-docentapi-* extensions: origin, the operation(s) that
// produce it, lineage confidence, and whether a human confirmed it via an
// answered clarification. The x-docentapi- prefix follows the standard
// vendor-extension convention (Speakeasy's x-speakeasy-, etc.) — any tool
// that doesn't recognise it simply ignores it.
//
// `requestFields` (not `properties`) is a deliberately flat field-path map,
// not a nested JSON Schema `properties` tree — calling it `properties` would
// misrepresent it as spec-compliant nesting it does not attempt to be.

import { fieldMapFor, originOf, type FieldNode, type FieldOrigin } from '../fieldMap';
import type { Action, ImportRecord } from '../ir';
import { lineageFor, producersFor } from '../lineage';

export type HumanVerifiedLookup = (tool: string, field: string) => boolean;

// What a human told us, keyed by "tool field". `origin` is present only when
// their answer actually resolved to one — an answer about a field's format or a
// PUT's merge semantics confirms the field without reclassifying it.
export type HumanAnswer = { origin?: FieldOrigin };

// What triage concluded from evidence, with the sentence it relied on. Applied
// to the origin like a human answer, but never counted as one.
export type AssumedAnswer = { origin?: FieldOrigin; quote: string; sourceKind: string; sourceUrl?: string };

export type EnrichedSpecInput = {
  // Answered by a person. The key set doubles as x-docentapi-human-verified.
  answers?: Map<string, HumanAnswer>;
  // Concluded from evidence by the triage pass, not confirmed by anyone.
  assumptions?: Map<string, AssumedAnswer>;
  // Explicitly skipped: we asked, nobody could say. An honest unknown, and
  // deliberately distinct from never having asked.
  unresolved?: Set<string>;
  // Lineage edges the LLM pass disputed, keyed "tool field fromTool.fromField".
  disputed?: Set<string>;
};

function annotateField(action: Action, field: FieldNode, record: ImportRecord, input: EnrichedSpecInput) {
  const graph = lineageFor(record);
  const key = `${action.name} ${field.path}`;
  const disputed = input.disputed ?? new Set<string>();

  // A producer the model disputed is withheld from the artifact but kept in
  // evidence_facts, so the claim disappears without the audit trail doing so.
  const producers = producersFor(graph, action.name, field.path).filter(
    (p) => !disputed.has(`${key} ${p.from.tool}.${p.from.field}`),
  );

  const answer = input.answers?.get(key);
  // Only consulted when no person answered. A human answer always wins over an
  // inference drawn from the same evidence that produced the question.
  const assumption = answer ? undefined : input.assumptions?.get(key);
  const heuristicOrigin = originOf(field, producers.length > 0);
  // A person who knows the API outranks our inference about it. Without this the
  // owner could answer "the server assigns this, ignore what I send" and the
  // published spec would still read caller_supplied — now stamped
  // human-verified, which is worse than never having asked.
  const origin = answer?.origin ?? assumption?.origin ?? heuristicOrigin;

  return {
    type: field.nullable ? [field.type, 'null'] : field.type,
    ...(field.format ? { format: field.format } : {}),
    ...(field.enum ? { enum: field.enum } : {}),
    ...(field.description ? { description: field.description } : {}),
    'x-docentapi-origin': origin,
    // Which of the three produced the value above, so a consumer never has to
    // guess whether it is reading a person's answer, an inference from the
    // provider's own documentation, or our structural heuristic.
    'x-docentapi-origin-source': answer?.origin ? 'human' : assumption?.origin ? 'assumed' : 'heuristic',
    ...(producers.length
      ? {
          'x-docentapi-produced-by': producers.map((p) => ({
            operation: p.from.tool,
            field: p.from.field,
            confidence: p.confidence,
          })),
        }
      : {}),
    // Strictly a person. An assumption never sets this, no matter how well
    // evidenced — that is the line between "someone who knows this API told us"
    // and "we read it somewhere", and it is the whole value of the marker.
    'x-docentapi-human-verified': input.answers?.has(key) ?? false,
    // Carries its own receipt: the sentence relied on and where it came from, so
    // a consumer can judge the inference instead of taking it on faith.
    ...(assumption
      ? {
          'x-docentapi-assumed': {
            quote: assumption.quote,
            source: assumption.sourceKind,
            ...(assumption.sourceUrl ? { url: assumption.sourceUrl } : {}),
          },
        }
      : {}),
    // Asked and unanswerable. Distinct from an absent marker, which only means
    // we never asked.
    ...(input.unresolved?.has(key) ? { 'x-docentapi-unresolved': true } : {}),
  };
}

export function buildEnrichedSpec(
  record: ImportRecord,
  // Accepts the legacy bare Set of verified keys so existing callers and tests
  // keep working; the object form is what carries answers, skips and disputes.
  verifiedOrInput: Set<string> | EnrichedSpecInput = new Set(),
): Record<string, unknown> {
  const input: EnrichedSpecInput =
    verifiedOrInput instanceof Set
      ? { answers: new Map([...verifiedOrInput].map((k) => [k, {} as HumanAnswer])) }
      : verifiedOrInput;
  const paths: Record<string, Record<string, unknown>> = {};

  for (const action of record.actions) {
    const map = fieldMapFor(action);
    const requestFields: Record<string, unknown> = {};
    for (const field of map.request) {
      if (field.container) continue;
      requestFields[field.path] = annotateField(action, field, record, input);
    }

    const pathEntry = paths[action.path] ?? {};
    pathEntry[action.method.toLowerCase()] = {
      operationId: action.name,
      description: action.description,
      'x-docentapi-safety': action.safety,
      requestFields,
    };
    paths[action.path] = pathEntry;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: `${record.name} — DocentAPI-enriched`,
      version: '1.0.0',
      description:
        "Assembled from DocentAPI's normalized model of this API, not a re-annotation of the original file. Every field carries x-docentapi-* tags describing its origin, known producers, and whether a human confirmed it.",
    },
    paths,
  };
}
