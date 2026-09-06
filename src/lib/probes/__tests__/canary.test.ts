import { describe, expect, it } from 'vitest';
import type { Action, ImportRecord } from '../../ir';
import type { invokeAction } from '../../mcpTools';
import { DEFAULT_SAMPLES, MAX_OPERATIONS, runCanary } from '../canary';

function action(overrides: Partial<Action> = {}): Action {
  return {
    id: 'a1',
    name: 'get_pet',
    description: 'Get a pet',
    method: 'GET',
    path: '/pets/{id}',
    paramsSchema: { type: 'object', properties: { id: { type: 'string', 'x-docentapi-in': 'path' } }, required: ['id'] },
    auth: 'none',
    safety: 'read',
    examples: [{ params: { id: 'abc' } }],
    ...overrides,
  };
}

function record(overrides: Partial<ImportRecord> = {}): ImportRecord {
  const actions = overrides.actions ?? [action()];
  return {
    id: 'c1',
    name: 'Canary API',
    source: 'openapi',
    baseUrls: ['https://api.example.com'],
    auth: 'none',
    actions,
    counts: { total: actions.length, read: actions.length, write: 0, destructive: 0 },
    createdAt: 0,
    expiresAt: 0,
    ...overrides,
  };
}

function respond(bodies: string[], status = 200, headers?: Record<string, string>): typeof invokeAction {
  let i = 0;
  return (async () => {
    const bodyText = bodies[Math.min(i, bodies.length - 1)];
    i++;
    return { status, latencyMs: 10 + i, bodyText, ...(headers ? { headers } : {}) };
  }) as typeof invokeAction;
}

describe('runCanary', () => {
  it('takes several samples of one operation and merges them into one snapshot', async () => {
    const result = await runCanary({ record: record(), invoke: respond(['{"id":"x","name":"n"}']) });

    expect(result.snapshots).toHaveLength(1);
    const snapshot = result.snapshots[0];
    expect(snapshot.sampleCount).toBe(DEFAULT_SAMPLES);
    expect(snapshot.statusCounts).toEqual({ '200': DEFAULT_SAMPLES });
    expect(snapshot.shape['response.id'].presentIn).toBe(DEFAULT_SAMPLES);
    expect(snapshot).toMatchObject({ actionKey: 'a1', tool: 'get_pet', method: 'GET', path: '/pets/{id}' });
    expect(snapshot.latencyP50Ms).toBeGreaterThan(0);
  });

  // Repeating a call is only a "sample" if the call has no effect. This is why
  // a write can never be included, not merely why it should not be.
  it('never samples a write or destructive operation', async () => {
    let called = 0;
    const result = await runCanary({
      record: record({
        actions: [
          action({ id: 'w', name: 'create_pet', method: 'POST', safety: 'write' }),
          action({ id: 'd', name: 'delete_pet', method: 'DELETE', safety: 'destructive' }),
        ],
      }),
      invoke: (async () => {
        called++;
        return { status: 200, latencyMs: 1, bodyText: '{}' };
      }) as typeof invokeAction,
    });

    expect(called).toBe(0);
    expect(result.snapshots).toEqual([]);
  });

  // An outage is not a contract change. Letting 500s look like "every field
  // disappeared" is the most obvious way a canary becomes a false alarm.
  it('builds no shape from non-2xx responses and reports the operation inconclusive', async () => {
    const result = await runCanary({ record: record(), invoke: respond(['{"error":"boom"}'], 503) });

    expect(result.snapshots).toEqual([]);
    expect(result.inconclusive).toEqual(['get_pet']);
  });

  it('degrades to the successful samples when some fail', async () => {
    let i = 0;
    const invoke = (async () => {
      i++;
      if (i === 2) throw new Error('transient');
      return { status: 200, latencyMs: 5, bodyText: '{"id":"x"}' };
    }) as typeof invokeAction;

    const result = await runCanary({ record: record(), invoke });
    expect(result.snapshots[0].sampleCount).toBe(DEFAULT_SAMPLES - 1);
  });

  it('ignores an unparseable body rather than throwing', async () => {
    const result = await runCanary({ record: record(), invoke: respond(['<html>nope</html>']) });
    expect(result.snapshots).toEqual([]);
    expect(result.inconclusive).toEqual(['get_pet']);
  });

  it('bounds how many operations one run touches', async () => {
    const many = Array.from({ length: 12 }, (_, i) => action({ id: `a${i}`, name: `op_${i}`, path: `/p${i}` }));
    const result = await runCanary({ record: record({ actions: many }), invoke: respond(['{"id":"x"}']) });
    expect(result.snapshots.length).toBeLessThanOrEqual(MAX_OPERATIONS);
  });

  it('honours an explicit sample and operation budget', async () => {
    let called = 0;
    const invoke = (async () => {
      called++;
      return { status: 200, latencyMs: 1, bodyText: '{"id":"x"}' };
    }) as typeof invokeAction;

    await runCanary({ record: record({ actions: [action(), action({ id: 'a2', name: 'op2', path: '/p2' })] }), invoke }, { samples: 2, maxOperations: 1 });
    expect(called).toBe(2);
  });

  it('records one lifecycle signal per operation, not one per sample', async () => {
    const result = await runCanary({
      record: record(),
      invoke: respond(['{"id":"x"}'], 200, { sunset: 'Wed, 30 Jun 2027 23:59:59 GMT' }),
    });
    expect(result.evidence.filter((e) => e.kind === 'probe.lifecycle_signal')).toHaveLength(1);
  });
});

describe('runCanary eligibility', () => {
  it('samples an operation that requires nothing', async () => {
    const bare = action({ id: 'b', name: 'get_inventory', path: '/store/inventory', paramsSchema: { type: 'object', properties: {} }, examples: [] });
    const result = await runCanary({ record: record({ actions: [bare] }), invoke: respond(['{"sold":1}']) });
    expect(result.snapshots).toHaveLength(1);
  });

  // Guessing a required identifier produces a 404 and a shape describing an
  // error page, which is worse than not looking.
  it('skips an operation whose required parameters have no example', async () => {
    const needsId = action({ examples: [] });
    let called = 0;
    await runCanary({
      record: record({ actions: [needsId] }),
      invoke: (async () => {
        called++;
        return { status: 200, latencyMs: 1, bodyText: '{}' };
      }) as typeof invokeAction,
    });
    expect(called).toBe(0);
  });

  it('samples it once the spec supplies an example for every required parameter', async () => {
    const result = await runCanary({ record: record({ actions: [action()] }), invoke: respond(['{"id":"x"}']) });
    expect(result.snapshots).toHaveLength(1);
  });
});
