// Real identifiers for the reads that need one.
//
// A detail read — GET /pets/{petId} — cannot be called from the spec alone: no
// example, no default, and a guessed id is a 404 that says nothing. But the
// lineage graph already knows which list operation PRODUCES that id
// (`list_pets.response.data[].id → get_pet.path.petId`), and the chain runner
// already calls producers this way to verify those edges. This module runs the
// same producer call once, up front, and pools what it finds so docDrift,
// errorQuality and the conformance probes can fill a real id instead of
// skipping the operation.
//
// THE RULES ARE THE CHAIN RUNNER'S. Every value comes out of a response as a
// ValueRef and never as a string; the pool lives in the engine's closure and is
// cleared in a `finally`; a producer is called once per (tool, field) however
// many consumers want it; the page size is clamped to one row; and a producer
// that answers 429 aborts the harvest rather than being retried. Nothing here
// treats a response value as a URL.

import type { EvidenceFactInput } from '../evidence';
import type { Action } from '../ir';
import { lineageFor, type LineageEdge } from '../lineage';
import { selectValues, type ExtractReason } from '../lineageExtract';
import { isDangerousAction } from '../lineagePlan';
import { canFill, createValuePool, fillParams, producerParamsFor, type MutableValuePool, type ValuePool } from '../paramFill';
import { callProbe } from './context';
import { lifecycleEvidence } from './lifecycle';
import type { ProbeContext } from './types';

export const MAX_PRODUCERS = 3;
const MAX_VALUES_PER_PRODUCER = 2;

export type HarvestAbort = 'rate_limited' | 'budget_exhausted' | 'deadline_exceeded';

export type HarvestSkip = 'over_cap' | 'producer_failed' | 'unparseable' | ExtractReason;

export type HarvestProducer = {
  tool: string;
  field: string;
  /** How many (consumer, argument) pairs this producer was fetched for. */
  consumers: number;
  /** 'ok' when at least one value was pooled; otherwise why not. */
  reason: 'ok' | HarvestSkip;
  candidateCount: number;
};

export type HarvestResult = {
  pool: ValuePool;
  producers: HarvestProducer[];
  /** Reads that needed an id and found no eligible producer for it. */
  unresolved: Array<{ tool: string; arg: string }>;
  requestsMade: number;
  aborted: HarvestAbort | null;
  evidence: EvidenceFactInput[];
  /** Drops every pooled value. The engine calls this in its `finally`. */
  clear(): void;
};

export type HarvestOptions = { maxProducers?: number };

type Need = { consumer: Action; arg: string; edge: LineageEdge; producer: Action };

const CONFIDENCE_RANK = { high: 0, medium: 1, low: 2 } as const;

function isGetRead(action: Action): boolean {
  return action.method.toUpperCase() === 'GET' && action.safety === 'read';
}

// Which reads need a pooled value, and the best producer for each argument.
function plan(ctx: ProbeContext): { needs: Need[]; unresolved: Array<{ tool: string; arg: string }> } {
  const graph = lineageFor(ctx.record);
  const byName = new Map(ctx.record.actions.map((a) => [a.name, a]));
  const needs: Need[] = [];
  const unresolved: Array<{ tool: string; arg: string }> = [];

  for (const consumer of ctx.record.actions) {
    if (!isGetRead(consumer) || isDangerousAction(consumer)) continue;
    const specOnly = fillParams(consumer, { deterministic: true });
    if (specOnly.ok) continue;

    for (const arg of specOnly.missing) {
      const producers = graph.producersOf.get(consumer.name);
      const edges = [...(producers?.get(`path.${arg}`) ?? []), ...(producers?.get(`query.${arg}`) ?? [])]
        .filter((edge) => edge.confidence !== 'low')
        .sort((a, b) => CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence]);

      const usable = edges.find((edge) => {
        const producer = byName.get(edge.from.tool);
        return (
          producer !== undefined &&
          producer.name !== consumer.name &&
          isGetRead(producer) &&
          !isDangerousAction(producer) &&
          canFill(producer, { deterministic: true })
        );
      });
      if (!usable) {
        unresolved.push({ tool: consumer.name, arg });
        continue;
      }
      needs.push({ consumer, arg, edge: usable, producer: byName.get(usable.from.tool)! });
    }
  }
  return { needs, unresolved };
}

export async function harvestIds(ctx: ProbeContext, opts: HarvestOptions = {}): Promise<HarvestResult> {
  const maxProducers = opts.maxProducers ?? MAX_PRODUCERS;
  const pool: MutableValuePool = createValuePool();
  const producers: HarvestProducer[] = [];
  const evidence: EvidenceFactInput[] = [];
  let requestsMade = 0;
  let aborted: HarvestAbort | null = null;

  const { needs, unresolved } = plan(ctx);

  // One call per producer field, however many consumers it feeds.
  const groups = new Map<string, { producer: Action; field: string; needs: Need[] }>();
  for (const need of needs) {
    const key = `${need.producer.name}|${need.edge.from.field}`;
    const group = groups.get(key) ?? { producer: need.producer, field: need.edge.from.field, needs: [] };
    group.needs.push(need);
    groups.set(key, group);
  }

  let executed = 0;
  for (const group of groups.values()) {
    const report: HarvestProducer = {
      tool: group.producer.name,
      field: group.field,
      consumers: group.needs.length,
      reason: 'over_cap',
      candidateCount: 0,
    };
    producers.push(report);
    if (aborted || executed >= maxProducers) continue;
    executed++;

    let res: Awaited<ReturnType<typeof callProbe>> | null = null;
    requestsMade++;
    try {
      res = await callProbe(ctx, group.producer, producerParamsFor(group.producer, { runId: ctx.runId }));
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'BudgetExhaustedError') aborted = (err as { stop?: HarvestAbort }).stop ?? 'budget_exhausted';
      report.reason = 'producer_failed';
      continue;
    }
    evidence.push(...lifecycleEvidence(group.producer, res.headers));
    if (res.status === 429) {
      aborted = 'rate_limited';
      report.reason = 'producer_failed';
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      report.reason = 'producer_failed';
      continue;
    }

    let body: unknown;
    try {
      body = JSON.parse(res.bodyText);
    } catch {
      report.reason = 'unparseable';
      continue;
    }
    const extracted = selectValues(body, group.field, MAX_VALUES_PER_PRODUCER);
    report.candidateCount = extracted.candidateCount;
    if (!extracted.refs.length) {
      report.reason = extracted.reason;
      continue;
    }
    report.reason = 'ok';
    const entries = extracted.refs.map((ref) => ({ ref, source: 'harvested' as const }));
    for (const need of group.needs) pool.add(need.consumer.name, need.arg, entries);
  }

  return {
    pool,
    producers,
    unresolved,
    requestsMade,
    aborted,
    evidence,
    clear: () => pool.clear(),
  };
}
