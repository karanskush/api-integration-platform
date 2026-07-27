// Field-level data flow across an API: which operation's response produces the
// value another operation's request consumes.
//
// This is L2_ENGINE_SPEC.md §3's "Entity Dependency DAG", and BUILD_PLAN.md
// ranks it the single biggest time sink in an integration — "60–80% of
// integration time is spent discovering call order and where IDs come from".
// It is the difference between an agent that knows `POST /orders` needs a real
// `customerId` from `GET /customers`, and one that invents a plausible string.
//
// PRECISION IS THE WHOLE GAME. BUILD_PLAN.md:197 sets a ≥95% edge-accuracy gate
// and states outright that "wrong call sequences are worse than no guidance",
// which is correct: an edge that points an agent at the wrong resource can make
// it delete the wrong thing, whereas a missing edge only makes it ask. So this
// module is deliberately biased toward silence:
//
//   * a generic field name (`id`, `status`, `data`) NEVER produces an edge on
//     its own — it needs a corroborating signal;
//   * every edge carries the signals that justified it, so a wrong one is
//     debuggable rather than mysterious;
//   * low-confidence edges are computed but withheld unless asked for.
//
// Pure and synchronous, like fieldMap.ts and scorePreview.ts — no I/O — so it
// serves ephemeral imports identically to persisted ones. Persistence
// (evidence_facts) is an optimization and an audit record, never the source of
// truth.

import { buildFieldIndex, type ApiFieldIndex, type FieldNode } from './fieldMap';
import type { Action, ImportRecord } from './ir';
import {
  isGenericFieldName,
  isIdLike,
  normalizeFieldName,
  pathResources,
  resourceFromFieldName,
  singularize,
} from './resource';

export type LineageConfidence = 'high' | 'medium' | 'low';

// Which signals fired. Returned verbatim on every edge: an agent (or a human
// debugging a bad suggestion) can see exactly why the claim was made.
export type LineageSignal =
  | 'title_match' // both sides carry the same schema title — strongest
  | 'shape_match' // structurally identical objects
  | 'distinctive_name' // same non-generic field name
  | 'generic_name' // same field name, but a common one
  | 'foreign_key_name' // consumer is `petId`, producer is `id` on a pet route
  | 'resource_affinity' // producer and consumer paths mention the same resource
  | 'collection_producer' // producer is the list/create on that collection
  | 'format_match'
  | 'enum_overlap'
  | 'type_match'
  | 'type_mismatch';

export type LineageEdge = {
  // Keyed by tool NAME (stable and human-meaningful). Persisted edges key by
  // actionKey instead — see persist-side mapping.
  from: { tool: string; field: string };
  to: { tool: string; field: string };
  confidence: LineageConfidence;
  score: number;
  why: LineageSignal[];
};

export type LineageGraph = {
  edges: LineageEdge[];
  // consumer tool -> consumer field path -> edges producing it
  producersOf: Map<string, Map<string, LineageEdge[]>>;
  // producer tool -> producer field path -> edges consuming it
  consumersOf: Map<string, Map<string, LineageEdge[]>>;
  stats: { producerFields: number; consumerFields: number; considered: number; emitted: number };
};

const WEIGHTS: Record<LineageSignal, number> = {
  title_match: 50,
  shape_match: 35,
  distinctive_name: 40,
  // Not used in scoring — scoreGenericMatch() assigns a generic match's tier
  // directly rather than summing weights (see its header comment for why).
  // Kept here only so WEIGHTS stays exhaustive over LineageSignal.
  generic_name: 0,
  foreign_key_name: 45,
  resource_affinity: 25,
  collection_producer: 15,
  format_match: 15,
  enum_overlap: 25,
  type_match: 5,
  type_mismatch: -20,
};

const HIGH = 60;
const MEDIUM = 35;
const LOW = 20;

// Bounds: an API with 300 operations can present tens of thousands of fields.
const MAX_EDGES_PER_FIELD = 5;
const MAX_TOTAL_EDGES = 5000;
const MAX_BUCKET_SCAN = 200;

type ProducerField = {
  action: Action;
  field: FieldNode;
  resources: string[];
};

type ConsumerField = {
  action: Action;
  field: FieldNode;
  resources: string[];
};

// Scalar leaves only. A container has no value to flow — `body.customer` is
// structure; `body.customer.email` is the thing that actually gets carried from
// one call to the next.
function isFlowable(field: FieldNode): boolean {
  if (field.container) return false;
  if (field.type === 'object' || field.type === 'array') return false;
  return true;
}

function typesCompatible(a: FieldNode, b: FieldNode): boolean {
  if (a.type === b.type) return true;
  // integer/number are interchangeable for identifier purposes; unknown is a
  // parser gap rather than a real disagreement, so never penalize it.
  const numeric = new Set(['integer', 'number']);
  if (numeric.has(a.type) && numeric.has(b.type)) return true;
  return a.type === 'unknown' || b.type === 'unknown';
}

function enumOverlap(a: FieldNode, b: FieldNode): boolean {
  if (!a.enum?.length || !b.enum?.length) return false;
  const set = new Set(a.enum.map((v) => String(v)));
  return b.enum.some((v) => set.has(String(v)));
}

// Structural identity for object-valued fields. Two objects declaring the same
// property names are very likely the same type even when neither carries a
// title — which is common in hand-written specs.
function shapeFingerprint(field: FieldNode, index: ApiFieldIndex, tool: string, section: 'request' | 'response'): string | null {
  const map = index.get(tool);
  if (!map) return null;
  const prefix = `${field.path}.`;
  const children = map[section === 'request' ? 'request' : 'response']
    .filter((f) => f.path.startsWith(prefix) && !f.path.slice(prefix.length).includes('.'))
    .map((f) => `${f.name}:${f.type}`)
    .sort();
  return children.length >= 2 ? children.join('|') : null;
}

// Purely generic exact-name matches (`name`, `status`, `data`, ...) get their
// own scoring, deliberately NOT the additive weight-sum the distinctive/
// foreign-key path uses below.
//
// The accuracy corpus (lineageAccuracy.test.ts) is what surfaced why that
// matters: `type_match` and `collection_producer` fire almost automatically
// whenever two operations share a resource and a string-typed field — which
// is exactly true of `name`, `description`, and every other ordinary
// attribute a resource has. Additively stacking those onto resource_affinity
// pushed a coincidental shared attribute (list_pets.name and create_pet.name
// are two INDEPENDENT pieces of data, not one flowing into the other) over
// the medium-confidence threshold. That is precisely the "wrong edge" class
// this module exists to prevent.
//
// So a generic name gets a fixed tier from a short, explicit list of the only
// signals treated as real corroboration for a common word:
//   title match            -> high   (both sides are provably the same type)
//   overlapping enum values -> medium (the values themselves agree)
//   id-like name + shared resource -> medium (an unqualified `id` under the
//     same resource is the one generic-name case with real identifier
//     semantics — `list_pets[].id` really can feed `get_pet.path.id`)
//   anything else -> no edge
function scoreGenericMatch(
  producer: ProducerField,
  consumer: ConsumerField,
  sharedResource: boolean,
): { score: number; why: LineageSignal[] } | null {
  const titleMatch = Boolean(producer.field.title && consumer.field.title && producer.field.title === consumer.field.title);
  if (titleMatch) return { score: HIGH + 10, why: ['generic_name', 'title_match'] };

  if (enumOverlap(producer.field, consumer.field)) {
    return { score: MEDIUM + 10, why: ['generic_name', 'enum_overlap'] };
  }

  if (sharedResource && isIdLike(consumer.field.name)) {
    return { score: MEDIUM + 3, why: ['generic_name', 'resource_affinity'] };
  }

  return null;
}

function scoreEdge(producer: ProducerField, consumer: ConsumerField): { score: number; why: LineageSignal[] } | null {
  const producerName = normalizeFieldName(producer.field.name);
  const consumerName = normalizeFieldName(consumer.field.name);
  const generic = isGenericFieldName(consumerName);

  const fkResource = resourceFromFieldName(consumer.field.name);
  const exactName = producerName === consumerName;
  // `petId` consumed, `id` produced on a route that mentions `pet`.
  const foreignKey =
    !exactName && fkResource !== null && producerName === 'id' && producer.resources.includes(fkResource);

  if (!exactName && !foreignKey) return null; // names must relate somehow; nothing else is evidence enough

  // Resource affinity. For a foreign-key match the resource came from the field
  // name; otherwise compare the two operations' paths.
  const sharedResource = foreignKey
    ? true
    : producer.resources.some((r) => consumer.resources.includes(r)) ||
      (fkResource !== null && producer.resources.includes(fkResource));

  if (exactName && generic) return scoreGenericMatch(producer, consumer, sharedResource);

  const why: LineageSignal[] = [exactName ? 'distinctive_name' : 'foreign_key_name'];
  let score = exactName ? WEIGHTS.distinctive_name : WEIGHTS.foreign_key_name;

  const titleMatch = Boolean(producer.field.title && consumer.field.title && producer.field.title === consumer.field.title);
  if (titleMatch) {
    why.push('title_match');
    score += WEIGHTS.title_match;
  }

  if (sharedResource) {
    why.push('resource_affinity');
    score += WEIGHTS.resource_affinity;
  }

  if (producer.field.format && producer.field.format === consumer.field.format) {
    why.push('format_match');
    score += WEIGHTS.format_match;
  }

  if (enumOverlap(producer.field, consumer.field)) {
    why.push('enum_overlap');
    score += WEIGHTS.enum_overlap;
  }

  if (typesCompatible(producer.field, consumer.field)) {
    why.push('type_match');
    score += WEIGHTS.type_match;
  } else {
    why.push('type_mismatch');
    score += WEIGHTS.type_mismatch;
  }

  // A list or create on the resource is the canonical place an identifier comes
  // from, and is what an agent should be sent to first. Reserved for
  // distinctive/foreign-key matches — see scoreGenericMatch's header for why a
  // generic match must not earn this bonus.
  if ((producer.action.method === 'GET' || producer.action.method === 'POST') && sharedResource) {
    why.push('collection_producer');
    score += WEIGHTS.collection_producer;
  }

  return { score, why };
}

function confidenceFor(score: number): LineageConfidence | null {
  if (score >= HIGH) return 'high';
  if (score >= MEDIUM) return 'medium';
  if (score >= LOW) return 'low';
  return null;
}

export type LineageOptions = {
  // Off by default: low-confidence edges are guesses, and the cost of a wrong
  // one is higher than the cost of a missing one.
  includeLow?: boolean;
};

export function computeLineage(record: ImportRecord, options: LineageOptions = {}): LineageGraph {
  const index = buildFieldIndex(record);
  const byName = new Map<string, ProducerField[]>();
  const producers: ProducerField[] = [];
  const consumers: ConsumerField[] = [];

  const resourcesByTool = new Map<string, string[]>();
  for (const action of record.actions) resourcesByTool.set(action.name, pathResources(action.path));

  for (const action of record.actions) {
    const map = index.get(action.name);
    if (!map) continue;
    const resources = resourcesByTool.get(action.name) ?? [];

    for (const field of map.response) {
      if (!isFlowable(field)) continue;
      const entry: ProducerField = { action, field, resources };
      producers.push(entry);
      const key = normalizeFieldName(field.name);
      const bucket = byName.get(key);
      if (bucket) bucket.push(entry);
      else byName.set(key, [entry]);
    }

    for (const field of map.request) {
      // A readOnly request field is documentation of a server-assigned value,
      // not something a caller supplies — tracing it would be noise.
      if (!isFlowable(field) || field.readOnly) continue;
      consumers.push({ action, field, resources });
    }
  }

  const edges: LineageEdge[] = [];
  let considered = 0;

  for (const consumer of consumers) {
    if (edges.length >= MAX_TOTAL_EDGES) break;

    const consumerName = normalizeFieldName(consumer.field.name);
    const fkResource = resourceFromFieldName(consumer.field.name);

    // Two buckets: same-name producers, plus bare `id` producers when the
    // consumer looks like a foreign key. That second lookup is what makes
    // `petId` -> `GET /pets` work at all.
    const candidates = [...(byName.get(consumerName) ?? []), ...(fkResource ? (byName.get('id') ?? []) : [])];

    const scored: LineageEdge[] = [];
    for (const producer of candidates.slice(0, MAX_BUCKET_SCAN)) {
      if (producer.action.name === consumer.action.name) continue; // no self-edges
      considered++;

      const result = scoreEdge(producer, consumer);
      if (!result) continue;

      // Shape match is a late, expensive signal — only computed once a pair is
      // otherwise plausible.
      let { score, why } = result;
      if (producer.field.container === 'object' && consumer.field.container === 'object') {
        const a = shapeFingerprint(producer.field, index, producer.action.name, 'response');
        const b = shapeFingerprint(consumer.field, index, consumer.action.name, 'request');
        if (a && b && a === b) {
          why = [...why, 'shape_match'];
          score += WEIGHTS.shape_match;
        }
      }

      const confidence = confidenceFor(score);
      if (!confidence) continue;
      if (confidence === 'low' && !options.includeLow) continue;

      scored.push({
        from: { tool: producer.action.name, field: producer.field.path },
        to: { tool: consumer.action.name, field: consumer.field.path },
        confidence,
        score,
        why,
      });
    }

    scored.sort((a, b) => b.score - a.score);
    edges.push(...scored.slice(0, MAX_EDGES_PER_FIELD));
  }

  const producersOf = new Map<string, Map<string, LineageEdge[]>>();
  const consumersOf = new Map<string, Map<string, LineageEdge[]>>();
  for (const edge of edges) {
    const into = producersOf.get(edge.to.tool) ?? new Map<string, LineageEdge[]>();
    into.set(edge.to.field, [...(into.get(edge.to.field) ?? []), edge]);
    producersOf.set(edge.to.tool, into);

    const outOf = consumersOf.get(edge.from.tool) ?? new Map<string, LineageEdge[]>();
    outOf.set(edge.from.field, [...(outOf.get(edge.from.field) ?? []), edge]);
    consumersOf.set(edge.from.tool, outOf);
  }

  return {
    edges,
    producersOf,
    consumersOf,
    stats: {
      producerFields: producers.length,
      consumerFields: consumers.length,
      considered,
      emitted: edges.length,
    },
  };
}

// Memoization. The MCP handler can build a graph several times per request
// (get_call_sequence, describe_fields and trace_field all want one), and Fluid
// Compute reuses instances across requests, so recomputing a 300-action graph
// each time would be pure waste.
//
// Keyed on the RECORD OBJECT, not a derived string. A string key of
// id+count+createdAt looks unique but is not: two different records can agree
// on all three, and the collision hands back a graph computed from somebody
// else's actions — silently wrong answers, which is the worst failure this
// module can have. A WeakMap cannot collide, needs no eviction policy, and lets
// a discarded record's graph be collected with it.
const cache = new WeakMap<ImportRecord, Map<string, LineageGraph>>();

export function lineageFor(record: ImportRecord, options: LineageOptions = {}): LineageGraph {
  const variant = options.includeLow ? 'low' : 'std';
  let byVariant = cache.get(record);
  if (!byVariant) {
    byVariant = new Map();
    cache.set(record, byVariant);
  }

  const hit = byVariant.get(variant);
  if (hit) return hit;

  const graph = computeLineage(record, options);
  byVariant.set(variant, graph);
  return graph;
}

// Convenience reads for the advisor tools.

export function producersFor(graph: LineageGraph, tool: string, fieldPath: string): LineageEdge[] {
  return graph.producersOf.get(tool)?.get(fieldPath) ?? [];
}

export function consumersFor(graph: LineageGraph, tool: string, fieldPath: string): LineageEdge[] {
  return graph.consumersOf.get(tool)?.get(fieldPath) ?? [];
}

// Every field across the API whose leaf name matches, for the "I have a user id
// — what accepts it?" direction where the caller names a field rather than a
// path.
export function findFieldsByName(record: ImportRecord, name: string): Array<{ tool: string; field: FieldNode }> {
  const index = buildFieldIndex(record);
  const wanted = normalizeFieldName(name);
  const bare = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
  const wantedBare = normalizeFieldName(bare);
  const out: Array<{ tool: string; field: FieldNode }> = [];

  for (const [tool, map] of index) {
    for (const field of [...map.request, ...map.response]) {
      if (field.path === name) {
        out.unshift({ tool, field }); // exact path match ranks first
        continue;
      }
      const normalized = normalizeFieldName(field.name);
      if (normalized === wanted || normalized === wantedBare) out.push({ tool, field });
    }
  }
  return out;
}

export { singularize };
