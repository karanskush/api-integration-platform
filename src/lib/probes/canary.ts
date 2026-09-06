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

import type { Action } from '../ir';
import { invokeAction } from '../mcpTools';
import { inferShape, mergeShapes, percentile, type ObservedShape, type OperationSnapshot } from '../changes/observation';
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

export type CanaryResult = {
  snapshots: OperationSnapshot[];
  evidence: EvidenceFactInput[];
  // Operations that were eligible but produced no usable 2xx sample. Reported
  // rather than silently dropped: "we could not look" is a different statement
  // from "we looked and nothing changed", and the freshness surfaces must not
  // conflate them.
  inconclusive: string[];
};

// Can a request for this operation actually be built? Either it demands
// nothing, or the spec gave an example for everything it demands. Guessing a
// required identifier would produce a 404 and a shape describing an error.
function canConstruct(action: Action): boolean {
  const required = Array.isArray(action.paramsSchema.required)
    ? action.paramsSchema.required.filter((k): k is string => typeof k === 'string')
    : [];
  if (required.length === 0) return true;
  const example = action.examples[0]?.params ?? {};
  return required.every((key) => key in example);
}

function eligible(actions: Action[], limit: number): Action[] {
  return actions
    .filter((a) => a.safety === 'read')
    .filter(canConstruct)
    .slice(0, limit);
}

export async function runCanary(ctx: ProbeContext, opts: CanaryOptions = {}): Promise<CanaryResult> {
  const invoke = ctx.invoke ?? invokeAction;
  const samples = Math.max(1, opts.samples ?? DEFAULT_SAMPLES);
  const target = { baseUrls: ctx.record.baseUrls, authIn: ctx.record.authIn };

  const snapshots: OperationSnapshot[] = [];
  const evidence: EvidenceFactInput[] = [];
  const inconclusive: string[] = [];

  for (const action of eligible(ctx.record.actions, opts.maxOperations ?? MAX_OPERATIONS)) {
    const shapes: ObservedShape[] = [];
    const statusCounts: Record<string, number> = {};
    const latencies: number[] = [];
    let lifecycleSeen = false;

    for (let i = 0; i < samples; i++) {
      try {
        const res = await invoke(action, action.examples[0]?.params ?? {}, target, ctx.upstreamKey);
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
      inconclusive.push(action.name);
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
