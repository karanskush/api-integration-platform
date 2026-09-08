// Executes the chains lineagePlan.ts planned, and reports what happened.
//
// The effectful half of Executed Lineage, sitting beside canary.ts and shaped
// the same way: zero database access, pure over ctx.invoke, so it is fully
// testable with no network. lineageRun.ts persists what this returns.
//
// WHERE THE VALUES LIVE. The identifier read out of one response and sent to
// the next operation is held in a function-local Map for the duration of the
// run and cleared in a finally block. It is deliberately NOT a field on
// ProbeContext: that type is documented as the seam every sub-probe calls
// through, it flows into five other probes and every test double, and putting a
// value-bearing field there would make the leak surface global by construction.
// Everything in the map is a ValueRef, so even while it exists it cannot be
// serialized, interpolated or logged (transient.ts).
//
// WHAT COMES OUT. ChainObservation has no `unknown`, no `Record`, and no
// jsonb-shaped field — every member is a number, a null, or a member of a
// closed string union. That is not tidiness: this result is handed to
// score_runs.findings, which is `JSON.stringify(result)` into open jsonb, and
// the only durable way to guarantee nothing leaks there is for the type to have
// nowhere to put it.

import type { LineageConfidence } from '../lineage';
import { selectValues, type ExtractReason } from '../lineageExtract';
import {
  isDiscriminatingRejection,
  isSuccess,
  judgeRun,
  type ChainOutcome,
  type ChainReason,
} from '../lineageVerdict';
import { MAX_CANDIDATES_PER_CHAIN, type ExecutionPlan, type PlannedChain } from '../lineagePlan';
import { invokeAction } from '../mcpTools';
import { fabricateLike, resolveParams, type ValueRef } from '../transient';
import type { ProbeContext } from './types';

// Tighter than invokeAction's 30s default: a chain is several sequential calls
// inside a function with a 60s ceiling, and one slow endpoint must not consume
// the whole run.
const STEP_TIMEOUT_MS = 8_000;

// Identifiable and contactable, so a provider reading their access log can tell
// automated verification from someone using the playground.
const PROBE_USER_AGENT = 'docentapi-probe/1.0 (+https://www.docentapi.xyz)';

const MAX_CANDIDATE_VALUES = MAX_CANDIDATES_PER_CHAIN;

export type AbortReason = 'rate_limited' | 'budget_exhausted' | 'deadline_exceeded';

export type ChainObservation = {
  edgeKey: string;
  producerActionKey: string;
  producerTool: string;
  producerField: string;
  consumerActionKey: string;
  consumerTool: string;
  consumerField: string;
  inferredConfidence: LineageConfidence;
  attempts: number;
  successes: number;
  rejections: number;
  otherFailures: number;
  candidateCount: number;
  predominantStatus: number | null;
  controlAttempted: boolean;
  controlStatus: number | null;
  latencyP50Ms: number | null;
  extract: ExtractReason;
  outcome: ChainOutcome;
  reason: ChainReason;
};

export type ChainResult = {
  observations: ChainObservation[];
  requestsMade: number;
  aborted: AbortReason | null;
};

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function predominant(statuses: number[]): number | null {
  if (!statuses.length) return null;
  const counts = new Map<number, number>();
  for (const s of statuses) counts.set(s, (counts.get(s) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
}

export async function runLineageChains(ctx: ProbeContext, plan: ExecutionPlan): Promise<ChainResult> {
  const invoke = ctx.invoke ?? invokeAction;
  const target = { baseUrls: ctx.record.baseUrls, authIn: ctx.record.authIn };
  const observations: ChainObservation[] = [];
  let requestsMade = 0;
  let aborted: AbortReason | null = null;

  // Producer responses are reused across chains within one run: five consumers
  // taking customerId from list_customers should cost one list call, not five.
  // The tradeoff is that a ref's lifetime is the RUN rather than the chain —
  // acceptable because the finally below clears it and because a ValueRef
  // cannot be written down in the meantime.
  const produced = new Map<string, { refs: ValueRef[]; reason: ExtractReason }>();

  const call = async (
    action: PlannedChain['producer'],
    params: Record<string, unknown>,
  ): Promise<{ status: number; latencyMs: number; bodyText: string } | null> => {
    requestsMade++;
    try {
      // The one place a live value exists outside a ValueRef, and it is handed
      // straight to the request without being retained.
      return await invoke(action, resolveParams(params), target, ctx.upstreamKey, {
        timeoutMs: STEP_TIMEOUT_MS,
        userAgent: PROBE_USER_AGENT,
      });
    } catch (err) {
      // Never inspect or persist the message: ssrf.ts throws
      // `Invalid URL: ${rawUrl}`, and for an executed chain that URL contains
      // the extracted identifier. The name is all any caller here needs.
      const name = err instanceof Error ? err.name : '';
      if (name === 'BudgetExhaustedError') {
        aborted = (err as { stop?: AbortReason }).stop ?? 'budget_exhausted';
      }
      return null;
    }
  };

  try {
    for (const chain of plan.chains) {
      if (aborted) break;

      // --- 1. the producer, once per operation per run ---
      let candidates = produced.get(chain.producer.name);
      if (!candidates) {
        const res = await call(chain.producer, chain.producerParams);
        if (aborted) break;
        if (res && res.status === 429) {
          aborted = 'rate_limited';
          break;
        }
        if (!res || !isSuccess(res.status)) {
          candidates = { refs: [], reason: 'path_absent' };
        } else {
          try {
            const extracted = selectValues(JSON.parse(res.bodyText), chain.producerField, MAX_CANDIDATE_VALUES);
            candidates = { refs: extracted.refs, reason: extracted.reason };
          } catch {
            candidates = { refs: [], reason: 'unparseable' };
          }
        }
        produced.set(chain.producer.name, candidates);
      }

      const statuses: number[] = [];
      const latencies: number[] = [];
      let successes = 0;
      let rejections = 0;
      let otherFailures = 0;
      let controlAttempted = false;
      let controlStatus: number | null = null;

      // --- 2. the real candidates ---
      for (const ref of candidates.refs) {
        if (aborted) break;
        const res = await call(chain.consumer, { ...chain.baseParams, [chain.consumerArg]: ref });
        if (aborted) break;
        if (!res) {
          otherFailures++;
          continue;
        }
        if (res.status === 429) {
          aborted = 'rate_limited';
          break;
        }
        statuses.push(res.status);
        latencies.push(res.latencyMs);
        if (isSuccess(res.status)) successes++;
        else if (isDiscriminatingRejection(res.status)) rejections++;
        else otherFailures++;
      }

      // --- 3. the negative control ---
      // Only worth spending a request on when something actually succeeded:
      // with zero successes the control cannot change the verdict, and the
      // budget is better spent on the next chain.
      if (!aborted && successes > 0 && candidates.refs.length > 0) {
        const decoy = fabricateLike(candidates.refs[0]);
        const res = await call(chain.consumer, { ...chain.baseParams, [chain.consumerArg]: decoy });
        controlAttempted = true;
        if (res) {
          controlStatus = res.status;
          if (res.status === 429) aborted = 'rate_limited';
        }
      }

      const attempts = statuses.length + otherFailures;
      const verdict = judgeRun({
        candidatesTried: attempts,
        successes,
        rejections,
        otherFailures,
        controlAttempted,
        controlStatus,
        aborted: aborted !== null,
        extract: candidates.reason,
      });

      observations.push({
        edgeKey: chain.edgeKey,
        producerActionKey: chain.producer.id,
        producerTool: chain.producer.name,
        producerField: chain.producerField,
        consumerActionKey: chain.consumer.id,
        consumerTool: chain.consumer.name,
        consumerField: chain.consumerField,
        inferredConfidence: chain.inferredConfidence,
        attempts,
        successes,
        rejections,
        otherFailures,
        candidateCount: candidates.refs.length,
        predominantStatus: predominant(statuses),
        controlAttempted,
        controlStatus,
        latencyP50Ms: percentile(latencies, 50),
        extract: candidates.reason,
        outcome: verdict.outcome,
        reason: verdict.reason,
      });
    }
  } finally {
    // The values do not outlive the run. Belt and braces beside ValueRef's own
    // guarantees: nothing here is reachable once this returns.
    produced.clear();
  }

  return { observations, requestsMade, aborted };
}
