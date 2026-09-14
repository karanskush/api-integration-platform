import type { EvidenceFactInput } from '../evidence';
import type { Action } from '../ir';
import { specOnlyFiller } from '../paramFill';
import { validateResponse } from '../responseValidate';
import { callProbe } from './context';
import { lifecycleEvidence } from './lifecycle';
import { buildNegativePartitions, type Partition } from './partitions';
import type { ProbeContext, ProbeOutcome } from './types';

const FULL = 25;
const SAMPLE_LIMIT = 2;
const MAX_PARTITIONS = 4;
const MESSAGE_KEY = /^(message|error|detail)$/i;

/** True when a JSON error body carries a message a person could act on. Exported for the conformance probe. */
export function hasReadableMessage(bodyText: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return false;
  }
  return findMessage(parsed, 0);
}

function findMessage(value: unknown, depth: number): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (MESSAGE_KEY.test(key) && typeof v === 'string' && v.length >= 10) return true;
    if (depth === 0 && findMessage(v, depth + 1)) return true;
  }
  return false;
}

/** Whether an error body matches the spec's documented error schema; null when none is documented or it will not parse. */
export function matchesErrorSchema(action: Action, bodyText: string): boolean | null {
  if (!action.errorSchema) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return false;
  }
  return validateResponse(action.errorSchema, parsed).valid;
}

// Grades how the API says no. Each sampled read gets the negative partitions
// partitions.ts can build for it — a required parameter omitted, an id no
// record has, a typed parameter sent as prose — sent with client-side
// validation OFF where the request deliberately breaks the schema. Every
// response is recorded as a partition fact; the score counts only the ones
// that were actually errors.
export async function runErrorQuality(ctx: ProbeContext): Promise<ProbeOutcome> {
  const fill = ctx.fill ?? specOnlyFiller;

  const samples: Array<{ action: Action; partition: Partition }> = [];
  let sampledOps = 0;
  for (const action of ctx.record.actions) {
    if (sampledOps >= SAMPLE_LIMIT || samples.length >= MAX_PARTITIONS) break;
    if (action.safety !== 'read') continue;
    const partitions = buildNegativePartitions(action, fill(action, { runId: ctx.runId }), { runId: ctx.runId });
    if (!partitions.length) continue;
    sampledOps++;
    for (const partition of partitions) {
      if (samples.length >= MAX_PARTITIONS) break;
      samples.push({ action, partition });
    }
  }

  if (samples.length === 0) return { subscore: 0, evidence: [], insufficientData: true };

  const evidence: EvidenceFactInput[] = [];
  let passCount = 0;
  let graded = 0;
  for (const { action, partition } of samples) {
    try {
      const res = await callProbe(ctx, action, partition.params, { validate: partition.validate });
      // Recorded, never scored — see probes/lifecycle.ts.
      evidence.push(...lifecycleEvidence(action, res.headers));

      // A 401/403 means the request never reached validation: the API rejected
      // the caller, not the payload. authClarity records that; grading its body
      // here would score how an API says "who are you" as how it says "that
      // field is missing".
      if (res.status === 401 || res.status === 403) continue;

      const readable = hasReadableMessage(res.bodyText);
      const partitionFact: EvidenceFactInput = {
        kind: 'probe.negative_partition',
        source: 'probe',
        actionId: action.id,
        payload: {
          actionId: action.id,
          partition: partition.kind,
          field: partition.field,
          status: res.status,
          rejected: res.status >= 400,
          matchesErrorSchema: res.status >= 400 ? matchesErrorSchema(action, res.bodyText) : null,
          hasReadableMessage: readable,
        },
      };

      // This probe grades ERROR bodies, so it needs an error. A 2xx means the
      // corrupted request was accepted anyway and there is nothing to grade —
      // previously a 200 carrying a `message` field scored a point, which
      // rewarded an API for the opposite of what is being measured. The
      // partition itself is still recorded: "accepted a request the spec
      // forbids" is a finding about the API.
      if (res.status < 400) {
        evidence.push(partitionFact);
        continue;
      }

      graded++;
      if (readable) passCount++;
      evidence.push({
        kind: 'probe.error_quality',
        source: 'probe',
        actionId: action.id,
        payload: { actionId: action.id, sampleStatus: res.status, hasReadableMessage: readable },
      });
      evidence.push(partitionFact);
    } catch {
      // Unreachable or refused before the wire, so no response existed to
      // grade. Excluded rather than counted as a miss — and no fact written,
      // because the old `sampleStatus: 0` row rendered to users as "returned an
      // unreadable error on a 0 response", describing an exchange that never
      // happened.
      continue;
    }
  }

  // Nothing we sent provoked an error, so this API's error quality is
  // unmeasured — not bad. run.ts excludes the subscore from the total.
  if (graded === 0) return { subscore: 0, evidence, insufficientData: true };

  return { subscore: Math.round((passCount / graded) * FULL), evidence };
}
