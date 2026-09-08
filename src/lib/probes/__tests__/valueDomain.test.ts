// Checking whether an API honours its own declared enum.
//
// describe_fields has always reported `allowed` because the spec declares it,
// never because anyone checked. A spec that lists a value the API rejects is
// exactly the drift this product exists to catch, and it was invisible.

import { describe, expect, it, vi } from 'vitest';
import { runValueDomain } from '../valueDomain';
import type { Action, ImportRecord } from '../../ir';
import type { invokeAction } from '../../mcpTools';

function action(overrides: Partial<Action> & { name: string; path: string }): Action {
  return {
    id: `id_${overrides.name}`,
    description: `Does ${overrides.name}`,
    method: 'GET',
    paramsSchema: { type: 'object', properties: {} },
    auth: 'bearer',
    safety: 'read',
    examples: [],
    ...overrides,
  } as Action;
}

function withStatusEnum(overrides: Partial<Action> = {}): Action {
  return action({
    name: 'list_orders',
    path: '/v1/orders',
    paramsSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'closed', 'archived'], 'x-docentapi-in': 'query' },
      },
    },
    ...overrides,
  });
}

function record(actions: Action[]): ImportRecord {
  return {
    id: 'store',
    name: 'Store',
    source: 'openapi',
    baseUrls: ['https://api.store.test'],
    auth: 'bearer',
    actions,
    counts: { total: actions.length, read: actions.length, write: 0, destructive: 0 },
    createdAt: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
}

/** Accepts everything except the values named. */
function api(rejects: string[] = [], opts: { status?: number } = {}) {
  const sent: string[] = [];
  const invoke = (async (_a: Action, params: Record<string, unknown>) => {
    const value = String(params.status);
    sent.push(value);
    const bad = rejects.includes(value);
    return {
      status: bad ? (opts.status ?? 400) : 200,
      latencyMs: 5,
      bodyText: '{}',
    };
  }) as unknown as typeof invokeAction;
  return { invoke, sent };
}

const payloads = (evidence: Awaited<ReturnType<typeof runValueDomain>>) =>
  evidence.map((e) => e.payload as { field: string; value: string; accepted: boolean; status: number });

describe('checking a declared enum against the live API', () => {
  it('records which declared values were accepted', async () => {
    const { invoke } = api();
    const result = await runValueDomain({ record: record([withStatusEnum()]), invoke });

    expect(payloads(result).every((p) => p.accepted)).toBe(true);
    expect(payloads(result).map((p) => p.value).sort()).toEqual(['archived', 'closed', 'open']);
  });

  it('records a declared value the API actually rejects', async () => {
    const { invoke } = api(['archived']);
    const result = await runValueDomain({ record: record([withStatusEnum()]), invoke });

    const rejected = payloads(result).filter((p) => !p.accepted);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].value).toBe('archived');
    expect(rejected[0].status).toBe(400);
  });

  it('addresses the field the way describe_fields does', async () => {
    const { invoke } = api();
    const result = await runValueDomain({ record: record([withStatusEnum()]), invoke });
    expect(payloads(result)[0].field).toBe('query.status');
  });

  it('sends every declared value and nothing else', async () => {
    const { invoke, sent } = api();
    await runValueDomain({ record: record([withStatusEnum()]), invoke });
    expect(sent.sort()).toEqual(['archived', 'closed', 'open']);
  });
});

describe('what it refuses to touch', () => {
  it('never varies a write operation', async () => {
    const { invoke, sent } = api();
    const write = withStatusEnum({ name: 'create_order', method: 'POST', safety: 'write' });
    const result = await runValueDomain({ record: record([write]), invoke });

    expect(result).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('never varies a path parameter, which would address a different record', async () => {
    const { invoke, sent } = api();
    const pathEnum = action({
      name: 'get_order',
      path: '/v1/orders/{status}',
      paramsSchema: {
        type: 'object',
        required: ['status'],
        properties: { status: { type: 'string', enum: ['a', 'b'], 'x-docentapi-in': 'path' } },
      },
    });
    await runValueDomain({ record: record([pathEnum]), invoke });
    expect(sent).toHaveLength(0);
  });

  it('ignores a single-member enum, which proves nothing', async () => {
    const { invoke } = api();
    const single = withStatusEnum({
      paramsSchema: {
        type: 'object',
        properties: { status: { type: 'string', enum: ['open'], 'x-docentapi-in': 'query' } },
      },
    });
    expect(await runValueDomain({ record: record([single]), invoke })).toHaveLength(0);
  });

  it('skips an operation whose other required params cannot be supplied', async () => {
    const { invoke, sent } = api();
    const needsMore = withStatusEnum({
      paramsSchema: {
        type: 'object',
        required: ['tenantId'],
        properties: {
          status: { type: 'string', enum: ['open', 'closed'], 'x-docentapi-in': 'query' },
          tenantId: { type: 'string', 'x-docentapi-in': 'query' },
        },
      },
      examples: [],
    });
    await runValueDomain({ record: record([needsMore]), invoke });
    // Otherwise a rejection would be about the missing tenantId, not the value.
    expect(sent).toHaveLength(0);
  });
});

describe('a broken API is not a rejected value', () => {
  it('records nothing on a 5xx', async () => {
    const { invoke } = api(['open', 'closed', 'archived'], { status: 503 });
    const result = await runValueDomain({ record: record([withStatusEnum()]), invoke });

    // Telling an agent to stop sending a perfectly good value because the API
    // was briefly down would be worse than saying nothing.
    expect(result).toHaveLength(0);
  });

  it('records nothing when the call throws', async () => {
    const invoke = (async () => {
      throw new Error('unreachable');
    }) as unknown as typeof invokeAction;
    expect(await runValueDomain({ record: record([withStatusEnum()]), invoke })).toHaveLength(0);
  });
});

describe('cost', () => {
  it('stops after the operation cap', async () => {
    const { invoke, sent } = api();
    const many = Array.from({ length: 6 }, (_, i) =>
      withStatusEnum({ name: `list_${i}`, path: `/v1/things${i}` }),
    );
    await runValueDomain({ record: record(many), invoke });

    // 2 operations x 3 values.
    expect(sent).toHaveLength(6);
  });

  it('identifies itself as probe traffic', async () => {
    const invoke = vi.fn(async () => ({ status: 200, latencyMs: 1, bodyText: '{}' })) as unknown as typeof invokeAction;
    await runValueDomain({ record: record([withStatusEnum()]), invoke });

    const opts = (invoke as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][4] as { userAgent: string };
    expect(opts.userAgent).toContain('docentapi-probe');
  });
});
