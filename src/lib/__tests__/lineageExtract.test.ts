// The inverse of inferShape's walk. These fix the grammar contract: a producer
// path taken from the lineage graph must resolve against a real body using the
// same addressing changes/observation.ts and fieldMap.ts already use.

import { describe, expect, it } from 'vitest';
import { inferShape } from '../changes/observation';
import { selectValues } from '../lineageExtract';

const BODY = {
  data: [
    { id: 'cus_1', email: 'a@example.com', meta: { ref: 'r1' } },
    { id: 'cus_2', email: 'b@example.com', meta: { ref: 'r2' } },
    { id: 'cus_1', email: 'c@example.com', meta: { ref: 'r1' } },
  ],
  nextCursor: 'abc',
  total: 3,
};

const unwrap = (r: ReturnType<typeof selectValues>) => r.refs.map((ref) => ref.unwrap());

describe('reading a value at an inferShape path', () => {
  it('reads through an array', () => {
    const result = selectValues(BODY, 'response.data[].id', 10);
    expect(result.reason).toBe('ok');
    // Deduplicated: cus_1 appears twice in the body but is one candidate.
    expect(unwrap(result)).toEqual(['cus_1', 'cus_2']);
  });

  it('reads a top-level scalar', () => {
    expect(unwrap(selectValues(BODY, 'response.nextCursor', 10))).toEqual(['abc']);
  });

  it('reads a number', () => {
    expect(unwrap(selectValues(BODY, 'response.total', 10))).toEqual([3]);
  });

  it('reads through an array into a nested object', () => {
    expect(unwrap(selectValues(BODY, 'response.data[].meta.ref', 10))).toEqual(['r1', 'r2']);
  });

  it('honours the candidate cap', () => {
    expect(selectValues(BODY, 'response.data[].email', 2).refs).toHaveLength(2);
  });

  it('reports the count without the values', () => {
    const result = selectValues(BODY, 'response.data[].id', 10);
    expect(result.candidateCount).toBe(2);
    expect(JSON.stringify(result)).not.toContain('cus_1');
  });
});

// The whole point of sharing the grammar: whatever inferShape recorded, this
// must be able to read back.
describe('grammar agreement with inferShape', () => {
  it('resolves every scalar path inferShape produced for the same body', () => {
    const shape = inferShape(BODY);
    const scalarPaths = Object.entries(shape)
      .filter(([, info]) => info.types.some((t) => t === 'string' || t === 'number'))
      .map(([path]) => path);

    expect(scalarPaths.length).toBeGreaterThan(0);
    for (const path of scalarPaths) {
      expect(selectValues(BODY, path, 5).reason).toBe('ok');
    }
  });
});

describe('when there is nothing usable', () => {
  it('says the path is absent rather than guessing', () => {
    expect(selectValues(BODY, 'response.missing', 10).reason).toBe('path_absent');
    expect(selectValues(BODY, 'response.data[].missing', 10).reason).toBe('path_absent');
  });

  // An empty list is inconclusive — there was nothing to try. A non-empty list
  // whose elements lack the field is a different thing, and the canary's
  // reconcile() already owns that class of finding.
  it('distinguishes an empty collection from a missing path', () => {
    expect(selectValues({ data: [] }, 'response.data[].id', 10).reason).toBe('empty_collection');
  });

  it('refuses a non-scalar, which is not an identifier', () => {
    expect(selectValues({ data: [{ id: { nested: true } }] }, 'response.data[].id', 10).reason).toBe('non_scalar');
    expect(selectValues({ data: [{ id: ['x'] }] }, 'response.data[].id', 10).reason).toBe('non_scalar');
  });

  it('refuses a boolean', () => {
    expect(selectValues({ ok: true }, 'response.ok', 10).reason).toBe('non_scalar');
  });

  it('skips nulls without calling them a failure of the path', () => {
    const result = selectValues({ data: [{ id: null }, { id: 'cus_9' }] }, 'response.data[].id', 10);
    expect(unwrap(result)).toEqual(['cus_9']);
  });

  it('handles a root-only path', () => {
    expect(selectValues(BODY, 'response', 10).reason).toBe('path_absent');
  });

  it('handles a body that is not an object', () => {
    expect(selectValues('a string', 'response.id', 10).reason).toBe('path_absent');
    expect(selectValues(null, 'response.id', 10).reason).toBe('path_absent');
  });

  it('refuses an over-long value rather than carrying a blob around', () => {
    expect(selectValues({ id: 'x'.repeat(500) }, 'response.id', 10).reason).toBe('non_scalar');
  });
});

describe('nothing extracted is ever a bare value', () => {
  it('returns refs that cannot be serialized', () => {
    const result = selectValues(BODY, 'response.data[].id', 10);
    expect(JSON.stringify(result.refs)).toBe('["[transient]","[transient]"]');
  });
});

// The root can itself be an array. Missing that was a real bug the first live
// run caught: the Swagger Petstore's find_pets_by_status returns a top-level
// array, so its producer path is `response[].id`, and the walk never descended
// into it — reporting path_absent on a perfectly good response.
describe('a top-level array response', () => {
  const TOP_LEVEL = [{ id: 10 }, { id: 11 }, { id: 10 }];

  it('reads through the root array', () => {
    const result = selectValues(TOP_LEVEL, 'response[].id', 10);
    expect(result.reason).toBe('ok');
    expect(result.refs.map((r) => r.unwrap())).toEqual([10, 11]);
  });

  it('reads a nested field through the root array', () => {
    const body = [{ meta: { ref: 'a' } }, { meta: { ref: 'b' } }];
    expect(selectValues(body, 'response[].meta.ref', 10).refs.map((r) => r.unwrap())).toEqual(['a', 'b']);
  });

  it('reports an empty top-level array as an empty collection, not a missing path', () => {
    expect(selectValues([], 'response[].id', 10).reason).toBe('empty_collection');
  });

  it('agrees with what inferShape recorded for the same body', () => {
    const shape = inferShape(TOP_LEVEL);
    expect(Object.keys(shape)).toContain('response[].id');
    expect(selectValues(TOP_LEVEL, 'response[].id', 10).reason).toBe('ok');
  });
});
