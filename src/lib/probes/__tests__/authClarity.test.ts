import { describe, expect, it } from 'vitest';
import { runAuthClarity } from '../authClarity';
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
    paramsSchema: { type: 'object', properties: {} },
    auth: 'none',
    safety: 'read',
    examples: [{ params: {} }],
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
    auth: 'bearer',
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

function fakeInvoke(response: { status: number; latencyMs?: number; bodyText?: string } | Error): typeof invokeAction {
  return (async () => {
    if (response instanceof Error) throw response;
    return { status: response.status, latencyMs: response.latencyMs ?? 5, bodyText: response.bodyText ?? '' };
  }) as typeof invokeAction;
}

describe('runAuthClarity — static heuristic', () => {
  it('gives full marks for none/bearer/basic and a resolvable apiKey', async () => {
    const invoke = fakeInvoke({ status: 200 });
    for (const auth of ['none', 'bearer', 'basic'] as const) {
      const ctx: ProbeContext = { record: record({ auth }), invoke };
      expect((await runAuthClarity(ctx)).subscore).toBe(25);
    }
    const ctx: ProbeContext = {
      record: record({ auth: 'apiKey', authIn: { in: 'header', name: 'X-Api-Key' } }),
      invoke,
    };
    expect((await runAuthClarity(ctx)).subscore).toBe(25);
  });

  it('gives partial marks for apiKey without a resolvable placement', async () => {
    const ctx: ProbeContext = { record: record({ auth: 'apiKey' }), invoke: fakeInvoke({ status: 200 }) };
    expect((await runAuthClarity(ctx)).subscore).toBe(13);
  });

  it('gives low marks for oauth2', async () => {
    const ctx: ProbeContext = { record: record({ auth: 'oauth2' }), invoke: fakeInvoke({ status: 200 }) };
    expect((await runAuthClarity(ctx)).subscore).toBe(10);
  });

  it('skips the live bonus check entirely when auth is none', async () => {
    let called = false;
    const invoke = (async () => {
      called = true;
      return { status: 401, latencyMs: 5, bodyText: '' };
    }) as typeof invokeAction;
    const ctx: ProbeContext = { record: record({ auth: 'none' }), invoke };
    const result = await runAuthClarity(ctx);
    expect(called).toBe(false);
    expect(result.evidence).toHaveLength(0);
  });
});

describe('runAuthClarity — live unauthenticated-rejection bonus', () => {
  it('adds probe.auth_reject evidence when the unauthenticated call is rejected with 401', async () => {
    const ctx: ProbeContext = { record: record({ auth: 'bearer' }), invoke: fakeInvoke({ status: 401 }) };
    const result = await runAuthClarity(ctx);
    expect(result.subscore).toBe(25);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]).toMatchObject({
      kind: 'probe.auth_reject',
      payload: { statusObserved: 401, expectedAuth: 'bearer' },
    });
  });

  it('adds evidence for a 403 rejection too', async () => {
    const ctx: ProbeContext = { record: record({ auth: 'bearer' }), invoke: fakeInvoke({ status: 403 }) };
    const result = await runAuthClarity(ctx);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0].payload).toMatchObject({ statusObserved: 403 });
  });

  it('adds no evidence when the unauthenticated call is not rejected', async () => {
    const ctx: ProbeContext = { record: record({ auth: 'bearer' }), invoke: fakeInvoke({ status: 200 }) };
    const result = await runAuthClarity(ctx);
    expect(result.evidence).toHaveLength(0);
  });

  it('skips the bonus gracefully, without failing the probe, when the live call throws', async () => {
    const ctx: ProbeContext = {
      record: record({ auth: 'bearer' }),
      invoke: fakeInvoke(new Error('blocked by SSRF guard')),
    };
    const result = await runAuthClarity(ctx);
    expect(result.subscore).toBe(25);
    expect(result.evidence).toHaveLength(0);
  });

  it('skips the bonus gracefully when there is no base URL to call', async () => {
    let called = false;
    const invoke = (async () => {
      called = true;
      return { status: 401, latencyMs: 5, bodyText: '' };
    }) as typeof invokeAction;
    const ctx: ProbeContext = { record: record({ auth: 'bearer', baseUrls: [] }), invoke };
    await runAuthClarity(ctx);
    expect(called).toBe(false);
  });

  it('skips the bonus gracefully when there are no actions to test', async () => {
    let called = false;
    const invoke = (async () => {
      called = true;
      return { status: 401, latencyMs: 5, bodyText: '' };
    }) as typeof invokeAction;
    const ctx: ProbeContext = {
      record: record({ auth: 'bearer', actions: [], counts: { total: 0, read: 0, write: 0, destructive: 0 } }),
      invoke,
    };
    await runAuthClarity(ctx);
    expect(called).toBe(false);
  });
});
