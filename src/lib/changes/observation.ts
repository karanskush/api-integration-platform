// The behavioral canary's core: what an operation actually returned, reduced
// to a comparable shape, and the diff between two such shapes.
//
// Every other change source in this codebase compares one DOCUMENT to another
// — a spec against the previous spec, a response against the spec. None can
// see the failure the product is named for: the API's behaviour moving while
// its documentation stays perfectly still. That needs a record of what came
// back last time.
//
// SAFETY, and it is the reason this module exists rather than storing bodies:
// a response body is the likeliest place in the whole system for a customer's
// PII or a live token to appear. `inferShape` keeps the field PATH, the JSON
// type name, and nothing else. There is no code path here that copies a value
// out of a body, and the storage column has nowhere to put one.
//
// FALSE POSITIVES are the other design constraint. An API that returns an
// optional field on four requests and omits it on the fifth has not changed;
// a canary that reported that would be noise, and noise on a changelog is
// worse than silence because it trains people to ignore it. So a shape counts
// how many samples each field appeared in, and the diff only speaks when a
// field's presence is unambiguous on BOTH sides.

import type { Change, Severity } from './diff';

// Same bounds as fieldMap.ts, for the same reason: one hostile or merely huge
// response must not be able to swamp a snapshot row or a caller's context.
const MAX_DEPTH = 8;
const MAX_FIELDS = 400;
// Arrays are homogeneous in practice; sampling the first few elements catches
// a union without walking ten thousand rows.
const MAX_ARRAY_SAMPLE = 5;

export type FieldObservation = {
  // Sorted, deduplicated JSON type names seen at this path: 'string',
  // 'number', 'boolean', 'null', 'object', 'array'. Never a value.
  types: string[];
  // How many of the run's samples contained this path at all.
  presentIn: number;
};

export type ObservedShape = Record<string, FieldObservation>;

export type OperationSnapshot = {
  actionKey: string;
  tool: string;
  method: string;
  path: string;
  sampleCount: number;
  statusCounts: Record<string, number>;
  shape: ObservedShape;
  latencyP50Ms: number | null;
  latencyMaxMs: number | null;
};

function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

// One response body → the set of paths it contained, each seen once.
// Paths use fieldMap.ts's addressing so a canary finding and a spec finding
// name the same field the same way: `response.data[].id`.
export function inferShape(body: unknown, root = 'response'): ObservedShape {
  const shape: ObservedShape = {};
  let fields = 0;

  const walk = (value: unknown, path: string, depth: number): void => {
    if (fields >= MAX_FIELDS || depth > MAX_DEPTH) return;

    // The root is recorded too, so "the response stopped being an array"
    // is visible rather than only showing up as every child disappearing.
    shape[path] = { types: [jsonType(value)], presentIn: 1 };
    fields++;

    if (Array.isArray(value)) {
      for (const item of value.slice(0, MAX_ARRAY_SAMPLE)) {
        walkMerge(item, `${path}[]`, depth + 1);
      }
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (fields >= MAX_FIELDS) return;
        walk(child, `${path}.${key}`, depth + 1);
      }
    }
  };

  // Array elements share one path, so their types union rather than overwrite,
  // and the element path counts once no matter how many elements were sampled.
  const walkMerge = (value: unknown, path: string, depth: number): void => {
    if (fields >= MAX_FIELDS || depth > MAX_DEPTH) return;
    const existing = shape[path];
    if (existing) {
      const type = jsonType(value);
      if (!existing.types.includes(type)) existing.types = [...existing.types, type].sort();
    } else {
      shape[path] = { types: [jsonType(value)], presentIn: 1 };
      fields++;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, MAX_ARRAY_SAMPLE)) walkMerge(item, `${path}[]`, depth + 1);
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (fields >= MAX_FIELDS) return;
        walkMerge(child, `${path}.${key}`, depth + 1);
      }
    }
  };

  walk(body, root, 0);
  return shape;
}

// N samples → one shape whose presentIn counts say how consistently each path
// appeared. This is what makes "the field is gone" distinguishable from "the
// field is optional and this record did not have one".
export function mergeShapes(shapes: ObservedShape[]): ObservedShape {
  const merged: ObservedShape = {};
  for (const shape of shapes) {
    for (const [path, obs] of Object.entries(shape)) {
      const existing = merged[path];
      if (!existing) {
        merged[path] = { types: [...obs.types].sort(), presentIn: obs.presentIn };
        continue;
      }
      existing.presentIn += obs.presentIn;
      for (const type of obs.types) if (!existing.types.includes(type)) existing.types.push(type);
      existing.types.sort();
    }
  }
  return merged;
}

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

// ---------------------------------------------------------------------------
// The diff

// Below this many samples on either side, nothing is claimed. Two responses
// are an anecdote; the whole point of the canary is to be quieter than a
// naive differ, not louder.
export const MIN_SAMPLES = 3;

// A path present in every sample is unambiguously part of the contract; one
// present in some is optional and its absence proves nothing.
const STABLE = 1;

export type ObservationDiffOptions = { minSamples?: number };

function ratio(obs: FieldObservation | undefined, sampleCount: number): number {
  if (!obs || sampleCount <= 0) return 0;
  return obs.presentIn / sampleCount;
}

function behavioural(kind: Change['kind'], severity: Severity, snapshot: OperationSnapshot, fieldPath: string, extra: Partial<Change>, summary: string): Change {
  return {
    kind,
    severity,
    actionKey: snapshot.actionKey,
    tool: snapshot.tool,
    method: snapshot.method,
    path: snapshot.path,
    fieldPath,
    location: 'response',
    ...extra,
    summary,
  };
}

/**
 * What changed between two runs of the same operation.
 *
 * Emits the same `field.*` kinds the spec diff uses — a response field that
 * disappeared is a response field that disappeared, however it was found — and
 * the ledger's `source` column is what records that a probe rather than a
 * document is the evidence. Severities follow the same contravariance rule as
 * the spec diff: for a RESPONSE, losing something breaks callers and gaining
 * something surprises them.
 */
export function diffSnapshots(
  prev: OperationSnapshot,
  next: OperationSnapshot,
  opts: ObservationDiffOptions = {},
): Change[] {
  const minSamples = opts.minSamples ?? MIN_SAMPLES;
  // Not enough evidence on one side or the other: say nothing at all rather
  // than guess. A quiet canary is the correct canary here.
  if (prev.sampleCount < minSamples || next.sampleCount < minSamples) return [];

  const changes: Change[] = [];
  const label = `${next.tool} response`;
  const paths = new Set([...Object.keys(prev.shape), ...Object.keys(next.shape)]);

  for (const path of [...paths].sort()) {
    const before = prev.shape[path];
    const after = next.shape[path];
    const beforeRatio = ratio(before, prev.sampleCount);
    const afterRatio = ratio(after, next.sampleCount);

    // Gone: it was in every previous sample and in none of these.
    if (beforeRatio >= STABLE && afterRatio === 0) {
      changes.push(
        behavioural('field.removed', 'breaking', next, path, { before: before!.types.join('|') }, `${label} no longer returns ${path} — it was present in all ${prev.sampleCount} previous samples and none of the ${next.sampleCount} current ones`),
      );
      continue;
    }

    // New: absent before, in every sample now.
    if (beforeRatio === 0 && afterRatio >= STABLE) {
      changes.push(
        behavioural('field.added', 'additive', next, path, { after: after!.types.join('|') }, `${label} now returns ${path} (${after!.types.join('|')}) in all ${next.sampleCount} samples — it appeared in none previously`),
      );
      continue;
    }

    if (!before || !after) continue;

    // Type moved under a stably-present field. Compared as sets, because a
    // nullable field legitimately reports both its type and 'null'.
    const beforeTypes = before.types.filter((t) => t !== 'null');
    const afterTypes = after.types.filter((t) => t !== 'null');
    if (
      beforeRatio >= STABLE &&
      afterRatio >= STABLE &&
      beforeTypes.length &&
      afterTypes.length &&
      !beforeTypes.some((t) => afterTypes.includes(t))
    ) {
      changes.push(
        behavioural('field.type_changed', 'breaking', next, path, { before: before.types.join('|'), after: after.types.join('|') }, `${label} field ${path} changed type from ${beforeTypes.join('|')} to ${afterTypes.join('|')}`),
      );
      continue;
    }

    // Null arrived where it never used to.
    if (beforeRatio >= STABLE && !before.types.includes('null') && after.types.includes('null')) {
      changes.push(
        behavioural('field.nullable_changed', 'risky', next, path, { before: false, after: true }, `${label} field ${path} now sometimes returns null — it never did in the previous ${prev.sampleCount} samples`),
      );
      continue;
    }

    // Was in every sample, now only in some: a guarantee callers may have
    // relied on has quietly become optional.
    if (beforeRatio >= STABLE && afterRatio > 0 && afterRatio < STABLE) {
      changes.push(
        behavioural('field.required_changed', 'risky', next, path, { before: true, after: false }, `${label} field ${path} is no longer always present — ${after.presentIn} of ${next.sampleCount} samples, down from all ${prev.sampleCount}`),
      );
    }
  }

  return changes;
}

// ---------------------------------------------------------------------------
// Reconciliation

export type Reconciliation = 'consistent' | 'behavior_ahead' | 'spec_ahead';

/**
 * Whether what we observed is also what the spec says.
 *
 * This is the state matrix from the design doc, reduced to the one question a
 * single canary run can actually answer: does the live shape agree with the
 * documented shape? A field the API returns that the spec never mentions, or a
 * field the spec promises that the API stopped returning, is `behavior_ahead`
 * — the classic docs-drift case, and the one that marks an operation drifted.
 */
export function reconcile(observed: ObservedShape, sampleCount: number, documentedPaths: Set<string>): {
  state: Reconciliation;
  undocumented: string[];
  missing: string[];
} {
  // Nothing documented to compare against: silence, not a verdict.
  if (documentedPaths.size === 0) return { state: 'consistent', undocumented: [], missing: [] };

  const stable = Object.entries(observed)
    .filter(([, obs]) => ratio(obs, sampleCount) >= STABLE)
    .map(([path]) => path);

  // Containers are structure, not data — the spec's field list names leaves,
  // so comparing the root or an intermediate object would report noise.
  const undocumented = stable.filter((p) => p !== 'response' && !documentedPaths.has(p)).sort();
  const observedPaths = new Set(Object.keys(observed));
  const missing = [...documentedPaths].filter((p) => !observedPaths.has(p)).sort();

  const state: Reconciliation = undocumented.length || missing.length ? 'behavior_ahead' : 'consistent';
  return { state, undocumented, missing };
}
