import { describe, expect, it } from 'vitest';
import {
  diffSnapshots,
  inferShape,
  mergeShapes,
  MIN_SAMPLES,
  percentile,
  reconcile,
  type ObservedShape,
  type OperationSnapshot,
} from '../observation';

function snapshot(shape: ObservedShape, sampleCount = 3, overrides: Partial<OperationSnapshot> = {}): OperationSnapshot {
  return {
    actionKey: 'a1',
    tool: 'get_pet',
    method: 'GET',
    path: '/pets/{id}',
    sampleCount,
    statusCounts: { '200': sampleCount },
    shape,
    latencyP50Ms: 20,
    latencyMaxMs: 30,
    ...overrides,
  };
}

// Builds a shape as if the same body were seen `n` times.
function seen(body: unknown, n: number): ObservedShape {
  return mergeShapes(Array.from({ length: n }, () => inferShape(body)));
}

describe('inferShape', () => {
  it('records paths and JSON types, and never a value', () => {
    const shape = inferShape({ id: 'pet_1', age: 3, tags: ['a'], owner: { email: 'a@b.c' } });
    expect(Object.keys(shape).sort()).toEqual([
      'response',
      'response.age',
      'response.id',
      'response.owner',
      'response.owner.email',
      'response.tags',
      'response.tags[]',
    ]);
    expect(shape['response.id'].types).toEqual(['string']);
    expect(shape['response.age'].types).toEqual(['number']);

    // The safety property the whole module exists for: no value survives.
    const serialized = JSON.stringify(shape);
    expect(serialized).not.toContain('pet_1');
    expect(serialized).not.toContain('a@b.c');
    expect(serialized).not.toContain('3');
  });

  it('addresses array elements the way fieldMap does', () => {
    const shape = inferShape({ data: [{ id: 'x' }] });
    expect(shape['response.data[]'].types).toEqual(['object']);
    expect(shape['response.data[].id'].types).toEqual(['string']);
  });

  it('unions types across sampled array elements rather than overwriting', () => {
    const shape = inferShape({ data: [{ v: 'x' }, { v: 7 }] });
    expect(shape['response.data[].v'].types).toEqual(['number', 'string']);
    // One element path, however many elements were walked.
    expect(shape['response.data[].v'].presentIn).toBe(1);
  });

  it('records null distinctly from absent', () => {
    expect(inferShape({ note: null })['response.note'].types).toEqual(['null']);
  });

  it('records a non-object root, so "it stopped being an array" is visible', () => {
    expect(inferShape([1, 2])['response'].types).toEqual(['array']);
    expect(inferShape('plain')['response'].types).toEqual(['string']);
  });

  it('bounds depth and field count on a hostile body', () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 40; i++) deep = { nest: deep };
    expect(Object.keys(inferShape(deep)).length).toBeLessThanOrEqual(400);

    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 5000; i++) wide[`f${i}`] = i;
    expect(Object.keys(inferShape(wide)).length).toBeLessThanOrEqual(400);
  });
});

describe('mergeShapes', () => {
  it('counts how many samples each path appeared in', () => {
    const merged = mergeShapes([inferShape({ a: 1, b: 2 }), inferShape({ a: 1 }), inferShape({ a: 1 })]);
    expect(merged['response.a'].presentIn).toBe(3);
    expect(merged['response.b'].presentIn).toBe(1);
  });

  it('unions the types seen across samples', () => {
    const merged = mergeShapes([inferShape({ v: 'x' }), inferShape({ v: null })]);
    expect(merged['response.v'].types).toEqual(['null', 'string']);
  });
});

describe('percentile', () => {
  it('returns null for no samples and a member value otherwise', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([10, 20, 30], 50)).toBe(20);
    expect(percentile([5], 50)).toBe(5);
  });
});

describe('diffSnapshots — the false-positive discipline', () => {
  // Two responses are an anecdote. A canary that speaks on thin evidence
  // trains people to ignore the changelog.
  it('says nothing when either side has too few samples', () => {
    const prev = snapshot(seen({ id: 'x' }, 2), 2);
    const next = snapshot(seen({}, 5), 5);
    expect(diffSnapshots(prev, next)).toEqual([]);
    expect(MIN_SAMPLES).toBe(3);
  });

  // The core reason presence is counted rather than recorded as a boolean.
  it('does not report a field that was already intermittent', () => {
    const prev = snapshot(mergeShapes([inferShape({ id: 'x', note: 'n' }), inferShape({ id: 'x' }), inferShape({ id: 'x' })]), 3);
    const next = snapshot(seen({ id: 'x' }, 3), 3);
    expect(diffSnapshots(prev, next)).toEqual([]);
  });

  it('reports nothing at all when the shape is unchanged', () => {
    const shape = seen({ id: 'x', n: 1 }, 3);
    expect(diffSnapshots(snapshot(shape), snapshot(shape))).toEqual([]);
  });
});

describe('diffSnapshots — what it catches', () => {
  it('reports a field that was always present and is now always absent as breaking', () => {
    const changes = diffSnapshots(snapshot(seen({ id: 'x', name: 'n' }, 3)), snapshot(seen({ id: 'x' }, 3)));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: 'field.removed', severity: 'breaking', fieldPath: 'response.name', location: 'response' });
    expect(changes[0].summary).toContain('no longer returns response.name');
  });

  it('reports a newly consistent field as additive', () => {
    const changes = diffSnapshots(snapshot(seen({ id: 'x' }, 3)), snapshot(seen({ id: 'x', extra: true }, 3)));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: 'field.added', severity: 'additive', fieldPath: 'response.extra' });
  });

  it('reports a type change as breaking', () => {
    const changes = diffSnapshots(snapshot(seen({ id: 'x' }, 3)), snapshot(seen({ id: 7 }, 3)));
    expect(changes[0]).toMatchObject({ kind: 'field.type_changed', severity: 'breaking', fieldPath: 'response.id' });
    expect(changes[0].summary).toContain('from string to number');
  });

  it('treats a field that started returning null as risky, not as a type change', () => {
    const next = snapshot(mergeShapes([inferShape({ id: 'x' }), inferShape({ id: null }), inferShape({ id: 'y' })]), 3);
    const changes = diffSnapshots(snapshot(seen({ id: 'x' }, 3)), next);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: 'field.nullable_changed', severity: 'risky', fieldPath: 'response.id' });
  });

  it('reports a guarantee that became intermittent as risky', () => {
    const next = snapshot(mergeShapes([inferShape({ id: 'x', name: 'n' }), inferShape({ id: 'x' }), inferShape({ id: 'x' })]), 3);
    const changes = diffSnapshots(snapshot(seen({ id: 'x', name: 'n' }, 3)), next);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: 'field.required_changed', severity: 'risky', fieldPath: 'response.name' });
    expect(changes[0].summary).toContain('no longer always present');
  });

  it('carries the operation identity onto every finding', () => {
    const changes = diffSnapshots(snapshot(seen({ id: 'x', name: 'n' }, 3)), snapshot(seen({ id: 'x' }, 3)));
    expect(changes[0]).toMatchObject({ actionKey: 'a1', tool: 'get_pet', method: 'GET', path: '/pets/{id}' });
  });

  it('is deterministic and ordered by path', () => {
    const prev = snapshot(seen({ a: 1, b: 2, c: 3 }, 3));
    const next = snapshot(seen({ a: 1 }, 3));
    const first = diffSnapshots(prev, next);
    expect(first.map((c) => c.fieldPath)).toEqual(['response.b', 'response.c']);
    expect(diffSnapshots(prev, next)).toEqual(first);
  });
});

describe('reconcile', () => {
  const documented = new Set(['response.id', 'response.name']);

  it('is consistent when the observed shape matches the documented one', () => {
    const result = reconcile(seen({ id: 'x', name: 'n' }, 3), 3, documented);
    expect(result.state).toBe('consistent');
  });

  // The classic docs-drift case, and what marks an operation drifted.
  it('flags a field the API returns that the spec never mentions', () => {
    const result = reconcile(seen({ id: 'x', name: 'n', surprise: 1 }, 3), 3, documented);
    expect(result.state).toBe('behavior_ahead');
    expect(result.undocumented).toEqual(['response.surprise']);
  });

  it('flags a documented field the API stopped returning', () => {
    const result = reconcile(seen({ id: 'x' }, 3), 3, documented);
    expect(result.state).toBe('behavior_ahead');
    expect(result.missing).toEqual(['response.name']);
  });

  it('ignores an intermittent extra field rather than calling it drift', () => {
    const shape = mergeShapes([inferShape({ id: 'x', name: 'n', maybe: 1 }), inferShape({ id: 'x', name: 'n' }), inferShape({ id: 'x', name: 'n' })]);
    expect(reconcile(shape, 3, documented).state).toBe('consistent');
  });

  // An operation with no documented response schema cannot be in conflict
  // with one; silence beats a verdict built on nothing.
  it('stays silent when the spec documents no response fields', () => {
    expect(reconcile(seen({ anything: 1 }, 3), 3, new Set()).state).toBe('consistent');
  });
});
