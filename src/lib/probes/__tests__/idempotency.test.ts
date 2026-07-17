import { describe, expect, it } from 'vitest';
import { runIdempotency } from '../idempotency';
import type { ProbeContext } from '../types';
import type { Action, ImportRecord } from '../../ir';

function action(overrides: Partial<Action> = {}): Action {
  return {
    id: 'a1',
    name: 'create_thing',
    description: 'Create a thing',
    method: 'POST',
    path: '/things',
    paramsSchema: { type: 'object', properties: {} },
    auth: 'none',
    safety: 'write',
    examples: [],
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

describe('runIdempotency', () => {
  it('gives full marks when there are no write actions to flag', async () => {
    const read = action({ safety: 'read', method: 'GET' });
    const ctx: ProbeContext = { record: record({ actions: [read] }) };
    const result = await runIdempotency(ctx);
    expect(result).toEqual({ subscore: 25, evidence: [] });
  });

  it('gives full marks when every write action has an idempotency-shaped param', async () => {
    const cases = [
      { properties: { 'Idempotency-Key': { type: 'string' } } },
      { properties: { idempotency_key: { type: 'string' } } },
      { properties: { 'X-Request-Id': { type: 'string' } } },
      { properties: { 'request-id': { type: 'string' } } },
    ];
    for (const paramsSchema of cases) {
      const a = action({ paramsSchema: { type: 'object', ...paramsSchema } });
      const ctx: ProbeContext = { record: record({ actions: [a] }) };
      const result = await runIdempotency(ctx);
      expect(result.subscore).toBe(25);
      expect(result.evidence[0].payload).toMatchObject({ hasIdempotencySignal: true });
    }
  });

  it('gives zero marks when no write action has an idempotency signal', async () => {
    const a = action({ paramsSchema: { type: 'object', properties: { amount: { type: 'number' } } } });
    const ctx: ProbeContext = { record: record({ actions: [a] }) };
    const result = await runIdempotency(ctx);
    expect(result.subscore).toBe(0);
    expect(result.evidence[0].payload).toMatchObject({ hasIdempotencySignal: false });
    expect((result.evidence[0].payload as { matchedParam?: string }).matchedParam).toBeUndefined();
  });

  it('averages across mixed write actions', async () => {
    const a1 = action({
      id: 'a1',
      name: 'create_thing',
      paramsSchema: { type: 'object', properties: { 'Idempotency-Key': { type: 'string' } } },
    });
    const a2 = action({
      id: 'a2',
      name: 'update_thing',
      method: 'PUT',
      paramsSchema: { type: 'object', properties: { amount: { type: 'number' } } },
    });
    const ctx: ProbeContext = { record: record({ actions: [a1, a2] }) };
    const result = await runIdempotency(ctx);
    expect(result.subscore).toBe(13); // round(1/2 * 25)
    expect(result.evidence).toHaveLength(2);
  });

  it('never calls invoke — static scan only', async () => {
    let called = false;
    const invoke = (async () => {
      called = true;
      return { status: 200, latencyMs: 5, bodyText: '' };
    }) as ProbeContext['invoke'];
    const ctx: ProbeContext = { record: record(), invoke };
    await runIdempotency(ctx);
    expect(called).toBe(false);
  });

  it('ignores read/destructive actions in the scan', async () => {
    const read = action({ id: 'r1', name: 'get_thing', safety: 'read', method: 'GET' });
    const destructive = action({ id: 'd1', name: 'delete_thing', safety: 'destructive', method: 'DELETE' });
    const ctx: ProbeContext = { record: record({ actions: [read, destructive] }) };
    const result = await runIdempotency(ctx);
    expect(result.subscore).toBe(25);
    expect(result.evidence).toHaveLength(0);
  });
});
