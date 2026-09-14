// Samples an operation's live responses and reduces them to a shape.
//
// Runs on the same `ctx.invoke` seam every other probe uses, so it is unit
// testable with no network and inherits the SSRF boundary, the timeout, and
// the response-size cap for free.
//
// SAFETY: read-only, always. The sampler filters to `safety: 'read'` before it
// does anything else, and it takes several samples of each — which is exactly
// why a write operation could never be included: repeating a write is not a
// sample, it is N side effects. Bodies are inferred into shapes and dropped.
//
// DETERMINISTIC PARAMETERS. The canary compares a shape against the one it saw
// last run, so the request has to be the same request: it fills from the spec
// only — documented example, then declared default/enum — and never from the
// harvested pool, whose ids differ from run to run and would turn a different
// record's shape into "drift".

import type { Action } from '../ir';
import {
  MIN_SAMPLES,
  inferShape,
  mergeShapes,
  percentile,
  type ObservedShape,
  type OperationSnapshot,
} from '../changes/observation';
import { fillParams } from '../paramFill';
import { callProbe } from './context';
import { lifecycleEvidence } from './lifecycle';
import type { EvidenceFactInput } from '../evidence';
import type { ProbeContext } from './types';

// Enough samples for "present in all of them" to mean something, few enough
// that a canary run costs a provider a handful of reads. Multiplied by
// MAX_OPERATIONS this is the whole outbound budget of a run.
export const DEFAULT_SAMPLES = 3;
export const MAX_OPERATIONS = 5;

export type CanaryOptions = {
  samples?: number;
  maxOperations?: number;
};

/**
 * Why an eligible operation yielded nothing comparable.
 *
 * `no_successful_sample` — every attempt failed, threw, or answered non-2xx.
 * `below_min_samples`   — some samples succeeded, but fewer than diffSnapshots
 *                         requires, so no comparison could be made either way.
 */
export type InconclusiveReason = 'no_successful_sample' | 'below_min_samples';

/**
 * Carries the actionKey as well as the tool name.
 *
 * These used to be tool names while snapshots key on `action.id`, putting two
 * identifier spaces in one result. Nothing consumed more than `.length`, so it
 * never misbehaved — it was a trap for the first caller to try to join the two.
 */
export type InconclusiveOperation = {
  actionKey: string;
  tool: string;
  reason: InconclusiveReason;
};

export type CanaryResult = {
  snapshots: OperationSnapshot[];
  evidence: EvidenceFactInput[];
  // Operations that were eligible but produced nothing comparable. Reported
  // rather than silently dropped: "we could not look" is a different statement
  // from "we looked and nothing changed", and the freshness surfaces must not
  // conflate them.
  inconclusive: InconclusiveOperation[];
};

// Can a request for this operation actually be built from the spec alone?
// Guessing a required identifier would produce a 404 and a shape describing an
// error, so an id-shaped parameter with nothing declared keeps the operation out.
function constructible(action: Action): Record<string, unknown> | null {
  const outcome = fillParams(action, { deterministic: true });
  return outcome.ok ? outcome.params : null;
}

function eligible(actions: Action[], limit: number): Array<{ action: Action; params: Record<string, unknown> }> {
  const out: Array<{ action: Action; params: Record<string, unknown> }> = [];
  for (const action of actions) {
    if (out.length >= limit) break;
    if (action.safety !== 'read') continue;
    const params = constructible(action);
    if (params) out.push({ action, params });
  }
  return out;
}

export async function runCanary(ctx: ProbeContext, opts: CanaryOptions = {}): Promise<CanaryResult> {
  const samples = Math.max(1, opts.samples ?? DEFAULT_SAMPLES);

  const snapshots: OperationSnapshot[] = [];
  const evidence: EvidenceFactInput[] = [];
  const inconclusive: InconclusiveOperation[] = [];

  for (const { action, params } of eligible(ctx.record.actions, opts.maxOperations ?? MAX_OPERATIONS)) {
    const shapes: ObservedShape[] = [];
    const statusCounts: Record<string, number> = {};
    const latencies: number[] = [];
    let lifecycleSeen = false;

    for (let i = 0; i < samples; i++) {
      try {
        const res = await callProbe(ctx, action, params);
        statusCounts[String(res.status)] = (statusCounts[String(res.status)] ?? 0) + 1;
        latencies.push(res.latencyMs);

        // One lifecycle fact per operation, not one per sample.
        if (!lifecycleSeen) {
          const signals = lifecycleEvidence(action, res.headers);
          if (signals.length) {
            evidence.push(...signals);
            lifecycleSeen = true;
          }
        }

        // ONLY successful responses build a shape. An outage is not a contract
        // change, and letting a run of 500s look like "every field disappeared"
        // is the single most obvious way a canary turns into a false alarm.
        if (res.status < 200 || res.status >= 300) continue;
        shapes.push(inferShape(JSON.parse(res.bodyText)));
      } catch {
        // Unreachable, unparseable, or blocked — this sample simply does not
        // count. The run degrades to fewer samples, and MIN_SAMPLES decides
        // whether what is left may be compared at all.
      }
    }

    if (!shapes.length) {
      inconclusive.push({ actionKey: action.id, tool: action.name, reason: 'no_successful_sample' });
      continue;
    }

    // A snapshot below the comparison floor is reported and NOT stored.
    //
    // DEFAULT_SAMPLES and MIN_SAMPLES are both 3 and only 2xx responses build a
    // shape, so a single failed sample left sampleCount at 2 — and
    // diffSnapshots answers [] whenever either side is under the floor. The
    // snapshot was still written, which is the part that made this durable: it
    // became the newest row, so the NEXT run compared against an uncomparable
    // baseline and said nothing either. One transient blip silently disabled
    // drift detection for that operation across two runs, and nothing reported
    // it.
    //
    // Declining to store it keeps the last comparable snapshot as the baseline,
    // so the next run compares properly, and the operation is named here
    // instead of vanishing. Raising DEFAULT_SAMPLES would have masked the same
    // hole at 33% more outbound traffic per operation.
    if (shapes.length < MIN_SAMPLES) {
      inconclusive.push({ actionKey: action.id, tool: action.name, reason: 'below_min_samples' });
      continue;
    }

    snapshots.push({
      actionKey: action.id,
      tool: action.name,
      method: action.method,
      path: action.path,
      sampleCount: shapes.length,
      statusCounts,
      shape: mergeShapes(shapes),
      latencyP50Ms: percentile(latencies, 50),
      latencyMaxMs: latencies.length ? Math.max(...latencies) : null,
    });
  }

  return { snapshots, evidence, inconclusive };
}
