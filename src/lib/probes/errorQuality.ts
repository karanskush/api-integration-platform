import type { EvidenceFactInput } from '../evidence';
import type { Action } from '../ir';
import { specOnlyFiller, type ParamFiller } from '../paramFill';
import { callProbe } from './context';
import { lifecycleEvidence } from './lifecycle';
import type { ProbeContext, ProbeOutcome } from './types';

const FULL = 25;
const SAMPLE_LIMIT = 2;
const BAD_VALUE = '__docentapi_invalid__';
const MESSAGE_KEY = /^(message|error|detail)$/i;

type Corrupted = { params: Record<string, unknown>; validate: boolean };

// Starts from a request we could legitimately send, then breaks it in the way
// most likely to draw a 4xx without ever attempting a write:
//
//   1. drop a required query/header/body parameter. A path parameter cannot be
//      omitted — the URL would have a hole in it — so it is never the one
//      dropped. The request is sent with client-side validation OFF: the whole
//      point is to send what the spec forbids and see how the API says no, and
//      Ajv used to reject it before it reached the wire.
//   2. otherwise poison a path-placed parameter with a value no record has.
//
// Returns null when neither is possible — the action just doesn't qualify.
function corrupt(action: Action, fill: ParamFiller, runId?: string): Corrupted | null {
  const filled = fill(action, { runId });
  if (!filled.ok || Object.keys(filled.params).length === 0) return null;
  const params = { ...filled.params };

  const props = (action.paramsSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = (action.paramsSchema as { required?: unknown }).required;
  if (Array.isArray(required)) {
    const key = required.find(
      (k): k is string => typeof k === 'string' && k in params && props[k]?.['x-docentapi-in'] !== 'path',
    );
    if (key) {
      delete params[key];
      return { params, validate: false };
    }
  }

  const pathKey = Object.keys(props).find((k) => props[k]?.['x-docentapi-in'] === 'path' && k in params);
  if (pathKey) {
    params[pathKey] = BAD_VALUE;
    return { params, validate: true };
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
  const fill = ctx.fill ?? specOnlyFiller;

  const samples: Array<{ action: Action; corrupted: Corrupted }> = [];
  for (const action of ctx.record.actions) {
    if (samples.length >= SAMPLE_LIMIT) break;
    if (action.safety !== 'read') continue;
    const corrupted = corrupt(action, fill, ctx.runId);
    if (!corrupted) continue;
    samples.push({ action, corrupted });
  }

  if (samples.length === 0) return { subscore: 0, evidence: [], insufficientData: true };

  const evidence: EvidenceFactInput[] = [];
  let passCount = 0;
  let graded = 0;
  for (const { action, corrupted } of samples) {
    try {
      const res = await callProbe(ctx, action, corrupted.params, { validate: corrupted.validate });
      // Recorded, never scored — see probes/lifecycle.ts.
      evidence.push(...lifecycleEvidence(action, res.headers));

      // This probe grades ERROR bodies, so it needs an error. A 2xx means the
      // corrupted request was accepted anyway and there is nothing to grade —
      // previously a 200 carrying a `message` field scored a point, which
      // rewarded an API for the opposite of what is being measured.
      if (res.status < 400) continue;
      // A 401/403 means the request never reached validation: the API rejected
      // the caller, not the payload. authClarity records that; grading its body
      // here would score how an API says "who are you" as how it says "that
      // field is missing".
      if (res.status === 401 || res.status === 403) continue;

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
