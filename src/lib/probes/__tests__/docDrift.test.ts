import { describe, expect, it } from 'vitest';
import { runDocDrift } from '../docDrift';
import type { ProbeContext } from '../types';
import type { Action, ImportRecord } from '../../ir';
import type { invokeAction } from '../../mcpTools';

function action(overrides: Partial<Action> = {}): Action {
  return {
    id: 'a1',
    name: 'get_thing',
    description: 'Get a thing',
    method: 'GET',
    path: '/things/{id}',
    paramsSchema: {
      type: 'object',
      properties: { id: { type: 'string', 'x-docentapi-in': 'path' } },
      required: ['id'],
    },
    auth: 'none',
    safety: 'read',
    examples: [{ params: { id: 'abc' } }],
    responseSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, name: { type: 'string' }, count: { type: 'integer' } },
    },
    ...overrides,
  };
}

function record(overrides: Partial<ImportRecord> = {}): ImportRecord {
  const actions = overrides.actions ?? [action()];
  return {
    id: 'rec1',
    name: 'Test API',
    source: 'openapi',
    baseUrls: ['https://api.example.com'],
    auth: 'none',
    actions,
    counts: {
      total: actions.length,
      read: actions.filter((a) => a.safety === 'read').length,
      write: actions.filter((a) => a.safety === 'write').length,
      destructive: actions.filter((a) => a.safety === 'destructive').length,
    },
    createdAt: 0,
    expiresAt: 0,
    ...overrides,
  };
}

function fakeInvoke(bodyText: string, status = 200): typeof invokeAction {
  return (async () => ({ status, latencyMs: 5, bodyText })) as typeof invokeAction;
}

describe('runDocDrift', () => {
  it('marks insufficientData when no action has both an example and a responseSchema', async () => {
    const a = action({ responseSchema: undefined });
    const ctx: ProbeContext = { record: record({ actions: [a] }) };
    const result = await runDocDrift(ctx);
    expect(result).toEqual({ subscore: 0, evidence: [], insufficientData: true });
  });

  it('marks insufficientData when the only candidate has no example params', async () => {
    const a = action({ examples: [] });
    const ctx: ProbeContext = { record: record({ actions: [a] }) };
    const result = await runDocDrift(ctx);
    expect(result.insufficientData).toBe(true);
  });

  it('scores full marks when the response matches the declared schema shape', async () => {
    const invoke = fakeInvoke(JSON.stringify({ id: 'abc', name: 'Widget', count: 3 }));
    const ctx: ProbeContext = { record: record(), invoke };
    const result = await runDocDrift(ctx);
    expect(result.subscore).toBe(25);
    expect(result.evidence[0].payload).toMatchObject({ matchedFields: 3, declaredFields: 3, mismatches: [] });
  });

  it('flags a missing field', async () => {
    const invoke = fakeInvoke(JSON.stringify({ id: 'abc', name: 'Widget' }));
    const ctx: ProbeContext = { record: record(), invoke };
    const result = await runDocDrift(ctx);
    expect(result.subscore).toBe(Math.round((2 / 3) * 25));
    expect(result.evidence[0].payload).toMatchObject({ matchedFields: 2, declaredFields: 3 });
    expect((result.evidence[0].payload as { mismatches: string[] }).mismatches).toContain('missing_field:count');
  });

  it('flags a type mismatch', async () => {
    const invoke = fakeInvoke(JSON.stringify({ id: 'abc', name: 'Widget', count: 'three' }));
    const ctx: ProbeContext = { record: record(), invoke };
    const result = await runDocDrift(ctx);
    expect((result.evidence[0].payload as { mismatches: string[] }).mismatches).toContain('type_mismatch:count');
  });

  it('grades an unparseable response body as a full mismatch', async () => {
    const invoke = fakeInvoke('not json');
    const ctx: ProbeContext = { record: record(), invoke };
    const result = await runDocDrift(ctx);
    expect(result.subscore).toBe(0);
    expect(result.evidence[0].payload).toMatchObject({ matchedFields: 0, declaredFields: 3 });
  });

  it('averages the ratio across up to 3 sampled actions', async () => {
    const a1 = action({ id: 'a1', name: 'get_a' });
    const a2 = action({ id: 'a2', name: 'get_b', path: '/b/{id}' });
    const invoke: typeof invokeAction = async (action) => {
      if (action.id === 'a1') {
        return { status: 200, latencyMs: 5, bodyText: JSON.stringify({ id: 'x', name: 'y', count: 1 }) };
      }
      return { status: 200, latencyMs: 5, bodyText: JSON.stringify({ id: 'x' }) };
    };
    const ctx: ProbeContext = { record: record({ actions: [a1, a2] }), invoke };
    const result = await runDocDrift(ctx);
    expect(result.evidence).toHaveLength(2);
    // (3/3 + 1/3) / 2 * 25
    expect(result.subscore).toBe(Math.round(((3 / 3 + 1 / 3) / 2) * 25));
  });

  it('caps sampling at 3 actions even when more qualify', async () => {
    const actions = [
      action({ id: 'a1', name: 'get_a' }),
      action({ id: 'a2', name: 'get_b', path: '/b' }),
      action({ id: 'a3', name: 'get_c', path: '/c' }),
      action({ id: 'a4', name: 'get_d', path: '/d' }),
    ];
    const invoke = fakeInvoke(JSON.stringify({ id: 'x', name: 'y', count: 1 }));
    const ctx: ProbeContext = { record: record({ actions }), invoke };
    const result = await runDocDrift(ctx);
    expect(result.evidence).toHaveLength(3);
  });
});
