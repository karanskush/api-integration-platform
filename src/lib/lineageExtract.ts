// Reads the candidate values at one field path out of a real response body.
//
// The exact inverse of changes/observation.ts's inferShape walk, and
// deliberately so: that module addresses fields as `response.data[].id`, and
// fieldMap.ts uses the same grammar for spec fields, so a producer path taken
// from the lineage graph resolves against a live body without inventing a
// second addressing scheme. One grammar, three consumers.
//
// Everything it returns is a ValueRef. There is no code path here that hands
// back a bare value, which is what keeps "transient use, permanent claim" true
// by construction rather than by discipline — see transient.ts.

import { makeRef, type ValueRef } from './transient';

// Why nothing usable came back. A closed vocabulary rather than free text,
// because these end up in a `reason` column and an error string is the classic
// way a URL — and therefore an identifier — reaches a log.
export type ExtractReason =
  | 'ok'
  | 'path_absent'
  | 'empty_collection'
  | 'non_scalar'
  | 'unparseable';

export type ExtractResult = {
  refs: ValueRef[];
  /** A COUNT of distinct candidates, safe to store. Never the values. */
  candidateCount: number;
  reason: ExtractReason;
};

type Segment = { key: string; arrays: number };

// `response.data[].id` -> root 'response', segments [ {data, arrays:1}, {id, arrays:0} ].
// Returns null for a path with no segments to walk, which is a caller bug
// rather than a body problem.
function parsePath(fieldPath: string): { segments: Segment[] } | null {
  const parts = fieldPath.split('.');
  if (parts.length < 2) return null; // root only — nothing to read
  const segments: Segment[] = [];
  for (const raw of parts.slice(1)) {
    let key = raw;
    let arrays = 0;
    while (key.endsWith('[]')) {
      key = key.slice(0, -2);
      arrays++;
    }
    if (!key) return null;
    segments.push({ key, arrays });
  }
  return { segments };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Every distinct scalar at `fieldPath`, wrapped so it cannot be written down.
 *
 * Deduplicated: a list of twenty customers that all share a `status` yields one
 * candidate, not twenty, and trying the same value repeatedly would spend the
 * outbound budget proving nothing.
 */
export function selectValues(body: unknown, fieldPath: string, max: number): ExtractResult {
  const empty = (reason: ExtractReason): ExtractResult => ({ refs: [], candidateCount: 0, reason });

  const parsed = parsePath(fieldPath);
  if (!parsed) return empty('path_absent');

  let current: unknown[] = [body];
  // Distinguishing "we walked into an empty list" from "the field is not there"
  // matters: the first is inconclusive (nothing to try), the second is a
  // finding about the API — and the canary's reconcile() already owns that
  // class, so this must not quietly claim it.
  let sawEmptyCollection = false;

  for (const segment of parsed.segments) {
    const next: unknown[] = [];
    for (const node of current) {
      if (!isRecord(node)) continue;
      let values: unknown[] = [node[segment.key]];
      if (values[0] === undefined) continue;
      for (let i = 0; i < segment.arrays; i++) {
        const flattened: unknown[] = [];
        for (const value of values) {
          if (!Array.isArray(value)) continue;
          if (value.length === 0) sawEmptyCollection = true;
          flattened.push(...value);
        }
        values = flattened;
      }
      next.push(...values);
    }
    current = next;
    if (!current.length) break;
  }

  if (!current.length) return empty(sawEmptyCollection ? 'empty_collection' : 'path_absent');

  const seen = new Set<string | number>();
  const refs: ValueRef[] = [];
  let sawAnyValue = false;
  for (const value of current) {
    if (value === null || value === undefined) continue;
    sawAnyValue = true;
    const ref = makeRef(value);
    // makeRef rejects objects, arrays, booleans, empties and over-long blobs —
    // none of which is an identifier, and sending one would produce a
    // meaningless request whose failure we would then record as evidence about
    // the API rather than about our own input.
    if (!ref) continue;
    const key = ref.unwrap();
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
    if (refs.length >= max) break;
  }

  if (!refs.length) return empty(sawAnyValue ? 'non_scalar' : 'path_absent');

  return { refs, candidateCount: refs.length, reason: 'ok' };
}
