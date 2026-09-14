// The harvest calls a list endpoint once and pools what it finds so detail
// reads can be filled with a real identifier. Its rules are the chain
// runner's: ValueRefs only, one call per producer field, abort on 429.

import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import type { Action, ImportRecord } from '../../ir';
import type { invokeAction } from '../../mcpTools';
import { BudgetExhaustedError, createBudget, withBudget } from '../budget';
import { harvestIds } from '../harvest';

const SENTINEL = 'cus_SENTINEL_77aa';

const list: Action = {
  id: 'p1',
  name: 'list_customers',
  description: 'List customers',
  method: 'GET',
  path: '/customers',
  paramsSchema: { type: 'object', properties: { limit: { type: 'integer', 'x-docentapi-in': 'query' } } },
  auth: 'none',
  safety: 'read',
  examples: [],
  responseSchema: {
    type: 'object',
    properties: { data: { type: 'array', items: { type: 'object', properties: { customerId: { type: 'string' } } } } },
  },
};

const detail: Action = {
  id: 'c1',
  name: 'get_customer',
  description: 'Get a customer',
  method: 'GET',
  path: '/customers/{customerId}',
  paramsSchema: {
    type: 'object',
    properties: { customerId: { type: 'string', 'x-docentapi-in': 'path' } },
    required: ['customerId'],
  },
  auth: 'none',
  safety: 'read',
  examples: [],
  responseSchema: { type: 'object', properties: { customerId: { type: 'string' }, name: { type: 'string' } } },
};

function record(actions: Action[]): ImportRecord {
  return {
    id: 'r',
    name: 'Test API',
    source: 'openapi',
    baseUrls: ['https://api.example.com'],
    auth: 'none',
    actions,
    counts: { total: actions.length, read: actions.length, write: 0, destructive: 0 },
    createdAt: 0,
    expiresAt: 0,
  };
}

const respond = (status: number, body: unknown, headers?: Record<string, string>) =>
  (async () => ({ status, latencyMs: 5, bodyText: JSON.stringify(body), headers })) as typeof invokeAction;

describe('harvestIds', () => {
  it('calls the list once and pools a real id for the detail read', async () => {
    const invoke = vi.fn(respond(200, { data: [{ customerId: SENTINEL }, { customerId: 'cus_2' }] }));
    const result = await harvestIds({ record: record([list, detail]), invoke: invoke as typeof invokeAction });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(result.requestsMade).toBe(1);
    expect(result.producers).toEqual([
      { tool: 'list_customers', field: 'response.data[].customerId', consumers: 1, reason: 'ok', candidateCount: 2 },
    ]);
    const entries = result.pool.get('get_customer', 'customerId');
    expect(entries).toHaveLength(2);
    expect(entries[0].source).toBe('harvested');
  });

  it('clamps the producer to one row and sends no cursor', async () => {
    const invoke = vi.fn(respond(200, { data: [{ customerId: 'cus_1' }] }));
    await harvestIds({ record: record([list, detail]), invoke: invoke as typeof invokeAction });
    expect(invoke.mock.calls[0][1]).toEqual({ limit: 1 });
  });

  it('never lets a harvested value stringify', async () => {
    const result = await harvestIds({ record: record([list, detail]), invoke: respond(200, { data: [{ customerId: SENTINEL }] }) });
    const entry = result.pool.get('get_customer', 'customerId')[0];
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(inspect(entry.ref)).not.toContain(SENTINEL);
    expect(String(entry.ref)).not.toContain(SENTINEL);
  });

  it('has nothing to do when every read is already fillable', async () => {
    const invoke = vi.fn(respond(200, { data: [] }));
    const result = await harvestIds({ record: record([list]), invoke: invoke as typeof invokeAction });
    expect(invoke).not.toHaveBeenCalled();
    expect(result.producers).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });

  it('names a read it could not resolve rather than dropping it', async () => {
    const orphan: Action = { ...detail, id: 'c2', name: 'get_orphan', path: '/orphans/{orphanId}', paramsSchema: {
      type: 'object',
      properties: { orphanId: { type: 'string', 'x-docentapi-in': 'path' } },
      required: ['orphanId'],
    } };
    const result = await harvestIds({ record: record([list, orphan]), invoke: respond(200, { data: [] }) });
    expect(result.unresolved).toEqual([{ tool: 'get_orphan', arg: 'orphanId' }]);
  });

  it('records a producer that answered but produced no usable value', async () => {
    const result = await harvestIds({ record: record([list, detail]), invoke: respond(200, { data: [] }) });
    expect(result.producers[0].reason).not.toBe('ok');
    expect(result.pool.get('get_customer', 'customerId')).toEqual([]);
  });

  it('records a producer that failed, and stops on a 429', async () => {
    const failed = await harvestIds({ record: record([list, detail]), invoke: respond(500, { error: 'boom' }) });
    expect(failed.producers[0].reason).toBe('producer_failed');
    expect(failed.aborted).toBeNull();

    const limited = await harvestIds({ record: record([list, detail]), invoke: respond(429, {}) });
    expect(limited.aborted).toBe('rate_limited');
  });

  it('stops when the shared budget is spent, and says so', async () => {
    const budget = createBudget({ maxRequests: 0, deadlineMs: 60_000 });
    const result = await harvestIds({ record: record([list, detail]), invoke: withBudget(respond(200, {}), budget) });
    expect(result.aborted).toBe('budget_exhausted');
    expect(new BudgetExhaustedError('budget_exhausted').name).toBe('BudgetExhaustedError');
  });

  it('keeps rate-limit headers it saw on the way', async () => {
    const result = await harvestIds({
      record: record([list, detail]),
      invoke: respond(200, { data: [{ customerId: 'cus_1' }] }, { 'x-ratelimit-limit': '60' }),
    });
    expect(result.evidence.map((e) => e.kind)).toContain('probe.rate_limit');
  });

  it('caps how many producers one run calls', async () => {
    const list2: Action = { ...list, id: 'p2', name: 'list_orders', path: '/orders', responseSchema: {
      type: 'object',
      properties: { data: { type: 'array', items: { type: 'object', properties: { orderId: { type: 'string' } } } } },
    } };
    const detail2: Action = { ...detail, id: 'c2', name: 'get_order', path: '/orders/{orderId}', paramsSchema: {
      type: 'object',
      properties: { orderId: { type: 'string', 'x-docentapi-in': 'path' } },
      required: ['orderId'],
    } };
    const invoke = vi.fn(respond(200, { data: [{ customerId: 'a', orderId: 'b' }] }));
    const result = await harvestIds({ record: record([list, detail, list2, detail2]), invoke: invoke as typeof invokeAction }, { maxProducers: 1 });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(result.producers.map((p) => p.reason)).toContain('over_cap');
  });

  it('clear() empties the pool', async () => {
    const result = await harvestIds({ record: record([list, detail]), invoke: respond(200, { data: [{ customerId: 'cus_1' }] }) });
    expect(result.pool.get('get_customer', 'customerId')).toHaveLength(1);
    result.clear();
    expect(result.pool.get('get_customer', 'customerId')).toEqual([]);
  });
});
