// The chain runner.
//
// Doubled through ctx.invoke, the convention every probe test uses — which also
// makes the central assertion available directly: the consumer must have been
// called with the identifier the producer actually returned.

import { describe, expect, it, vi } from 'vitest';
import { inspect } from 'node:util';
import { buildExecutionPlan } from '../../lineagePlan';
import { runLineageChains } from '../lineageChain';
import { createBudget, withBudget } from '../budget';
import type { Action, ImportRecord } from '../../ir';
import type { invokeAction } from '../../mcpTools';

const REAL_ID = 'cus_SENTINEL01';
const OTHER_ID = 'cus_SENTINEL02';

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

function storeRecord(): ImportRecord {
  const actions = [
    action({
      name: 'list_customers',
      path: '/v1/customers',
      responseSchema: {
        type: 'object',
        properties: {
          data: { type: 'array', items: { type: 'object', properties: { customerId: { type: 'string' } } } },
        },
      },
    }),
    action({
      name: 'get_customer',
      path: '/v1/customers/{customerId}',
      paramsSchema: {
        type: 'object',
        required: ['customerId'],
        properties: { customerId: { type: 'string', 'x-docentapi-in': 'path' } },
      },
    }),
  ];
  return {
    id: 'store',
    name: 'Store',
    source: 'openapi',
    baseUrls: ['https://api.store.test'],
    auth: 'bearer',
    actions,
    counts: { total: 2, read: 2, write: 0, destructive: 0 },
    createdAt: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
}

const LIST_BODY = JSON.stringify({ data: [{ customerId: REAL_ID }, { customerId: OTHER_ID }] });

type Call = { tool: string; params: Record<string, unknown> };

/**
 * A stub that behaves like an API: the list returns two ids, and the detail
 * endpoint answers `detail` for a real id and `missing` for anything else —
 * which is precisely the discrimination the control is testing for.
 */
function api(opts: { detail?: number; missing?: number; list?: number; listBody?: string } = {}) {
  const calls: Call[] = [];
  const invoke = (async (a: Action, params: Record<string, unknown>) => {
    calls.push({ tool: a.name, params: { ...params } });
    if (a.name === 'list_customers') {
      return { status: opts.list ?? 200, latencyMs: 5, bodyText: opts.listBody ?? LIST_BODY };
    }
    const known = params.customerId === REAL_ID || params.customerId === OTHER_ID;
    return {
      status: known ? (opts.detail ?? 200) : (opts.missing ?? 404),
      latencyMs: 5,
      bodyText: known ? '{"customerId":"x"}' : '{"error":"not found"}',
    };
  }) as unknown as typeof invokeAction;
  return { invoke, calls };
}

async function run(invoke: typeof invokeAction) {
  const record = storeRecord();
  return runLineageChains({ record, invoke }, buildExecutionPlan(record));
}

describe('executing a chain', () => {
  it('confirms an edge when real ids work and a fabricated one does not', async () => {
    const { invoke } = api();
    const result = await run(invoke);

    expect(result.observations).toHaveLength(1);
    const [obs] = result.observations;
    expect(obs.outcome).toBe('confirmed');
    expect(obs.successes).toBe(2);
    expect(obs.controlAttempted).toBe(true);
    expect(obs.controlStatus).toBe(404);
  });

  it('sends the consumer the identifier the producer actually returned', async () => {
    const { invoke, calls } = api();
    await run(invoke);

    const detailCalls = calls.filter((c) => c.tool === 'get_customer');
    const sent = detailCalls.map((c) => c.params.customerId);
    expect(sent).toContain(REAL_ID);
    expect(sent).toContain(OTHER_ID);
  });

  it('sends a format-valid decoy that is not one of the real ids', async () => {
    const { invoke, calls } = api();
    await run(invoke);

    const sent = calls.filter((c) => c.tool === 'get_customer').map((c) => String(c.params.customerId));
    const decoys = sent.filter((v) => v !== REAL_ID && v !== OTHER_ID);
    expect(decoys).toHaveLength(1);
    // Same shape, so the provider's format validation still passes and a
    // non-2xx means "no such record" rather than "malformed".
    expect(decoys[0].startsWith('cus_')).toBe(true);
  });

  it('calls the producer once even when several chains need it', async () => {
    const { invoke, calls } = api();
    await run(invoke);
    expect(calls.filter((c) => c.tool === 'list_customers')).toHaveLength(1);
  });
});

// The failure this whole design exists to prevent.
describe('an API that answers 2xx to anything', () => {
  it('is reported inconclusive, never confirmed', async () => {
    // Soft-404: every id, real or fabricated, gets a 200.
    const { invoke } = api({ missing: 200 });
    const result = await run(invoke);

    const [obs] = result.observations;
    expect(obs.outcome).toBe('inconclusive');
    expect(obs.reason).toBe('control_also_succeeded');
    expect(obs.controlStatus).toBe(200);
  });
});

describe('when the API rejects everything', () => {
  it('contradicts on a clean sweep of not-founds', async () => {
    const { invoke } = api({ detail: 404 });
    const [obs] = (await run(invoke)).observations;

    expect(obs.outcome).toBe('contradicted');
    expect(obs.successes).toBe(0);
    // No point spending a control request when nothing succeeded.
    expect(obs.controlAttempted).toBe(false);
  });

  it('stays inconclusive on server errors, which say nothing about the edge', async () => {
    const { invoke } = api({ detail: 500 });
    const [obs] = (await run(invoke)).observations;

    expect(obs.outcome).toBe('inconclusive');
    expect(obs.reason).toBe('not_rejected_cleanly');
  });
});

describe('when the producer gives it nothing', () => {
  it('reports that rather than blaming the consumer', async () => {
    const { invoke, calls } = api({ listBody: JSON.stringify({ data: [] }) });
    const [obs] = (await run(invoke)).observations;

    expect(obs.outcome).toBe('inconclusive');
    expect(obs.reason).toBe('producer_yielded_nothing');
    expect(obs.extract).toBe('empty_collection');
    // Never guessed an id to keep going.
    expect(calls.filter((c) => c.tool === 'get_customer')).toHaveLength(0);
  });

  it('handles an unparseable producer body', async () => {
    const { invoke } = api({ listBody: 'not json' });
    const [obs] = (await run(invoke)).observations;
    expect(obs.extract).toBe('unparseable');
  });

  it('handles a producer that fails outright', async () => {
    const { invoke, calls } = api({ list: 500 });
    const [obs] = (await run(invoke)).observations;

    expect(obs.outcome).toBe('inconclusive');
    expect(calls.filter((c) => c.tool === 'get_customer')).toHaveLength(0);
  });
});

describe('stopping conditions', () => {
  it('aborts the whole run on a 429 rather than hammering', async () => {
    const invoke = (async (a: Action) =>
      a.name === 'list_customers'
        ? { status: 200, latencyMs: 5, bodyText: LIST_BODY }
        : { status: 429, latencyMs: 5, bodyText: '{}' }) as unknown as typeof invokeAction;

    const result = await run(invoke);
    expect(result.aborted).toBe('rate_limited');
  });

  it('stops when the shared budget is spent, and says so', async () => {
    const { invoke } = api();
    const record = storeRecord();
    const budgeted = withBudget(invoke, createBudget({ maxRequests: 1, deadlineMs: 60_000 }));

    const result = await runLineageChains({ record, invoke: budgeted }, buildExecutionPlan(record));
    expect(result.aborted).toBe('budget_exhausted');
    expect(result.requestsMade).toBeLessThanOrEqual(2);
  });

  it('draws no conclusion from a run it could not finish', async () => {
    const { invoke } = api();
    const record = storeRecord();
    // Enough for the producer and one candidate, not enough to finish.
    const budgeted = withBudget(invoke, createBudget({ maxRequests: 2, deadlineMs: 60_000 }));

    const result = await runLineageChains({ record, invoke: budgeted }, buildExecutionPlan(record));
    for (const obs of result.observations) expect(obs.outcome).not.toBe('confirmed');
  });
});

// score_runs.findings is JSON.stringify(result) into open jsonb, so this is the
// property that keeps an identifier out of the database entirely.
describe('nothing it returns can carry a value', () => {
  it('serializes without any identifier in it', async () => {
    const { invoke } = api();
    const result = await run(invoke);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('SENTINEL');
    expect(serialized).not.toContain(REAL_ID);
    // Not vacuous: the run really did handle those ids.
    expect(result.observations[0].successes).toBe(2);
  });

  it('does not leak through inspect either', async () => {
    const { invoke } = api();
    expect(inspect(await run(invoke), { depth: 10 })).not.toContain('SENTINEL');
  });

  it('keeps identifiers out of console output', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { invoke } = api();
    const result = await run(invoke);
    console.error('chain run', result);
    const logged = spy.mock.calls.flat().map((a) => inspect(a, { depth: 10 })).join(' ');
    spy.mockRestore();

    expect(logged).not.toContain('SENTINEL');
  });
});
