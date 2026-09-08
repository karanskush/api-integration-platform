// Which lineage edges can be verified by actually calling the API, and how.
//
// Pure and synchronous, like lineage.ts / fieldMap.ts / pagination.ts — no I/O,
// no DB — so it plans identically for an ephemeral paste and a persisted API.
// The effectful half is probes/lineageChain.ts, mirroring the canary's
// canary.ts / canaryRun.ts split.
//
// ELIGIBILITY IS STRICTER THAN THE CANARY'S, and that is the point. The canary
// calls with fabricated spec examples, which mostly 404. This calls with a REAL
// identifier just read out of the owner's production account, so an operation
// that merely classifies as `read` is not good enough:
//
//   * `safety` is derived from the HTTP method, so it is coarse. GET is
//     required explicitly on both ends.
//   * `GET /accounts/{id}/close` classifies as `read` today. A path-token
//     denylist catches the verbs that are consequential regardless of method.
//   * a body-side consumer implies a POST/PUT, which this never makes.
//
// Every rejection produces a typed SkipReason rather than a silent drop. The
// canary's live run taught that lesson: "we did not look" and "we looked and
// found nothing" collapsing into one silent outcome was the defect its own
// tests missed.

import type { Action, ImportRecord } from './ir';
import { lineageFor, type LineageConfidence, type LineageEdge, type LineageSignal } from './lineage';
import { paginationFor } from './pagination';

// Consequential regardless of method. A GET that closes an account is not a
// read in any sense that matters here.
const DANGEROUS_PATH_TOKENS =
  /(^|[/_-])(delete|remove|purge|destroy|revoke|cancel|close|reset|logout|disable|expire|consume|archive|deactivate)([/_-]|$)/i;

const MAX_CHAINS = 3;
const MAX_CANDIDATES_PER_CHAIN = 2;

export type SkipReason =
  | 'low_confidence'
  | 'consumer_not_path_or_query'
  | 'producer_not_get'
  | 'consumer_not_get'
  | 'dangerous_path'
  | 'consumer_params_unsatisfiable'
  | 'producer_params_unsatisfiable'
  | 'over_chain_cap';

export type PlannedChain = {
  edgeKey: string;
  producer: Action;
  /** inferShape/fieldMap addressing, e.g. `response.data[].id`. */
  producerField: string;
  consumer: Action;
  /** The consumer's ARGUMENT name, not its `path.`-prefixed field path. */
  consumerArg: string;
  consumerIn: 'path' | 'query';
  consumerField: string;
  /** The consumer's other required params, from its documented example. */
  baseParams: Record<string, unknown>;
  /** The producer's params, with any page-size parameter clamped to 1. */
  producerParams: Record<string, unknown>;
  inferredConfidence: LineageConfidence;
  why: LineageSignal[];
};

export type ExecutionPlan = {
  chains: PlannedChain[];
  skipped: Array<{ edgeKey: string; reason: SkipReason }>;
  /** Producer call + one per candidate + one negative control, per chain. */
  estimatedRequests: number;
};

/** The same key lineageAccuracy.test.ts uses, so labels line up across modules. */
export function edgeKey(edge: LineageEdge): string {
  return `${edge.from.tool}.${edge.from.field}->${edge.to.tool}.${edge.to.field}`;
}

function requiredParamNames(action: Action): string[] {
  const required = action.paramsSchema.required;
  return Array.isArray(required) ? required.filter((r): r is string => typeof r === 'string') : [];
}

// The canary's canConstruct, applied to a chain: every required parameter must
// be satisfiable from the documented example, EXCEPT the one the producer is
// about to supply.
function satisfiable(action: Action, suppliedBy?: string): boolean {
  const example = action.examples[0]?.params ?? {};
  return requiredParamNames(action).every((name) => name === suppliedBy || name in example);
}

function baseParamsFor(action: Action, exclude: string): Record<string, unknown> {
  const example = action.examples[0]?.params ?? {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(example)) {
    if (key === exclude) continue;
    out[key] = value;
  }
  return out;
}

// A "read" that paginates is still expensive for the provider, and safeFetch's
// 1MB cap truncates the RESPONSE, not their work — and a truncated body is
// unparseable, so the extractor would fail closed anyway. One row is all a
// chain needs, so clamp the page size and never send a cursor or offset.
function producerParamsFor(action: Action): Record<string, unknown> {
  const params = { ...(action.examples[0]?.params ?? {}) };
  const pagination = paginationFor(action);
  if (pagination.sizeParam) params[pagination.sizeParam] = 1;
  for (const key of [pagination.cursorParam, pagination.pageParam, pagination.offsetParam]) {
    if (key) delete params[key];
  }
  return params;
}

function isGet(action: Action): boolean {
  return action.method.toUpperCase() === 'GET';
}

function dangerous(action: Action): boolean {
  return DANGEROUS_PATH_TOKENS.test(action.path) || DANGEROUS_PATH_TOKENS.test(action.name);
}

// Ranking is fully deterministic so two runs plan the same chains and their
// results are comparable across time.
function rank(a: PlannedChain, b: PlannedChain): number {
  const order = { high: 0, medium: 1, low: 2 } as const;
  if (a.inferredConfidence !== b.inferredConfidence) {
    return order[a.inferredConfidence] - order[b.inferredConfidence];
  }
  const aCollection = a.why.includes('collection_producer') ? 0 : 1;
  const bCollection = b.why.includes('collection_producer') ? 0 : 1;
  if (aCollection !== bCollection) return aCollection - bCollection;
  if (a.consumer.path.length !== b.consumer.path.length) return a.consumer.path.length - b.consumer.path.length;
  return a.edgeKey.localeCompare(b.edgeKey);
}

export type PlanOptions = { maxChains?: number };

export function buildExecutionPlan(record: ImportRecord, options: PlanOptions = {}): ExecutionPlan {
  const maxChains = options.maxChains ?? MAX_CHAINS;
  const graph = lineageFor(record);
  const byName = new Map(record.actions.map((a) => [a.name, a]));

  const candidates: PlannedChain[] = [];
  const skipped: Array<{ edgeKey: string; reason: SkipReason }> = [];
  const skip = (edge: LineageEdge, reason: SkipReason) => skipped.push({ edgeKey: edgeKey(edge), reason });

  for (const edge of graph.edges) {
    // Low-confidence edges are withheld from tools already; executing one would
    // spend real requests on the engine's weakest guesses.
    if (edge.confidence === 'low') {
      skip(edge, 'low_confidence');
      continue;
    }

    const producer = byName.get(edge.from.tool);
    const consumer = byName.get(edge.to.tool);
    if (!producer || !consumer) continue;

    // `path.customerId` / `query.cursor` — a `body.` consumer implies a
    // POST/PUT, which a read-only executor never makes.
    const [location, ...rest] = edge.to.field.split('.');
    if (location !== 'path' && location !== 'query') {
      skip(edge, 'consumer_not_path_or_query');
      continue;
    }
    const consumerArg = rest.join('.');
    if (!consumerArg) {
      skip(edge, 'consumer_not_path_or_query');
      continue;
    }

    if (!isGet(producer) || producer.safety !== 'read') {
      skip(edge, 'producer_not_get');
      continue;
    }
    if (!isGet(consumer) || consumer.safety !== 'read') {
      skip(edge, 'consumer_not_get');
      continue;
    }
    if (dangerous(producer) || dangerous(consumer)) {
      skip(edge, 'dangerous_path');
      continue;
    }
    if (!satisfiable(producer)) {
      skip(edge, 'producer_params_unsatisfiable');
      continue;
    }
    if (!satisfiable(consumer, consumerArg)) {
      skip(edge, 'consumer_params_unsatisfiable');
      continue;
    }

    candidates.push({
      edgeKey: edgeKey(edge),
      producer,
      producerField: edge.from.field,
      consumer,
      consumerArg,
      consumerIn: location,
      consumerField: edge.to.field,
      baseParams: baseParamsFor(consumer, consumerArg),
      producerParams: producerParamsFor(producer),
      inferredConfidence: edge.confidence,
      why: edge.why,
    });
  }

  candidates.sort(rank);
  const chains = candidates.slice(0, maxChains);
  for (const dropped of candidates.slice(maxChains)) {
    skipped.push({ edgeKey: dropped.edgeKey, reason: 'over_chain_cap' });
  }

  return {
    chains,
    skipped,
    // One producer call, up to MAX_CANDIDATES_PER_CHAIN consumer calls, and one
    // negative control — the control being what separates a confirmation from
    // a coincidence (see lineageVerdict.ts).
    estimatedRequests: chains.length * (1 + MAX_CANDIDATES_PER_CHAIN + 1),
  };
}

export { MAX_CANDIDATES_PER_CHAIN, MAX_CHAINS };
