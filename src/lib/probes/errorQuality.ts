import type { EvidenceFactInput } from '../evidence';
import type { Action } from '../ir';
import { invokeAction } from '../mcpTools';
import { lifecycleEvidence } from './lifecycle';
import type { ProbeContext, ProbeOutcome } from './types';

const FULL = 25;
const SAMPLE_LIMIT = 2;
const BAD_VALUE = '__docentapi_invalid__';
const MESSAGE_KEY = /^(message|error|detail)$/i;

// Drops one required param (so the upstream has to reject a genuinely
// incomplete request) when the schema declares `required`; otherwise
// mutates a path-placed param, the next best way to force a 4xx without
// ever attempting a write. Returns null when neither is possible — the
// action just doesn't qualify for this probe.
function corrupt(action: Action): Record<string, unknown> | null {
  const example = action.examples[0]?.params;
  if (!example || Object.keys(example).length === 0) return null;
  const params = { ...example };

  const required = (action.paramsSchema as { required?: unknown }).required;
  if (Array.isArray(required)) {
    const key = required.find((k): k is string => typeof k === 'string' && k in params);
    if (key) {
      delete params[key];
      return params;
    }
  }

  const props = (action.paramsSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const pathKey = Object.keys(props).find((k) => props[k]?.['x-docentapi-in'] === 'path' && k in params);
  if (pathKey) {
    params[pathKey] = BAD_VALUE;
    return params;
  }

  return null;
}

function hasReadableMessage(bodyText: string): boolean {
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

export async function runErrorQuality(ctx: ProbeContext): Promise<ProbeOutcome> {
  const invoke = ctx.invoke ?? invokeAction;
  const target = { baseUrls: ctx.record.baseUrls, authIn: ctx.record.authIn };

  const samples: Array<{ action: Action; params: Record<string, unknown> }> = [];
  for (const action of ctx.record.actions) {
    if (samples.length >= SAMPLE_LIMIT) break;
    if (action.safety !== 'read') continue;
    const params = corrupt(action);
    if (!params) continue;
    samples.push({ action, params });
  }

  if (samples.length === 0) return { subscore: 0, evidence: [], insufficientData: true };

  const evidence: EvidenceFactInput[] = [];
  let passCount = 0;
  let graded = 0;
  for (const { action, params } of samples) {
    try {
      const res = await invoke(action, params, target, ctx.upstreamKey);
      // Recorded, never scored — see probes/lifecycle.ts.
      evidence.push(...lifecycleEvidence(action, res.headers));

      // This probe grades ERROR bodies, so it needs an error. A 2xx means the
      // corrupted request was accepted anyway and there is nothing to grade —
      // previously a 200 carrying a `message` field scored a point, which
      // rewarded an API for the opposite of what is being measured.
      if (res.status < 400) continue;

      graded++;
      const readable = hasReadableMessage(res.bodyText);
      if (readable) passCount++;
      evidence.push({
        kind: 'probe.error_quality',
        source: 'probe',
        actionId: action.id,
        payload: { actionId: action.id, sampleStatus: res.status, hasReadableMessage: readable },
      });
    } catch {
      // Rejected client-side (Ajv) or unreachable, so no response existed to
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
