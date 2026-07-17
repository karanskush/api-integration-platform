import { describe, expect, it } from 'vitest';
import { runErrorQuality } from '../errorQuality';
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
      properties: { id: { type: 'string', 'x-spotcheck-in': 'path' } },
      required: ['id'],
    },
    auth: 'none',
    safety: 'read',
    examples: [{ params: { id: 'abc' } }],
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

function fakeInvoke(fn: (args: Record<string, unknown>) => { status: number; bodyText: string }): typeof invokeAction {
  const invoke: typeof invokeAction = async (_action, args) => {
    const r = fn(args);
    return { status: r.status, latencyMs: 5, bodyText: r.bodyText };
  };
  return invoke;
}

describe('runErrorQuality', () => {
  it('marks insufficientData when no read action has example params', async () => {
    const noExamples = action({ examples: [] });
    const ctx: ProbeContext = { record: record({ actions: [noExamples] }) };
    const result = await runErrorQuality(ctx);
    expect(result).toEqual({ subscore: 0, evidence: [], insufficientData: true });
  });

  it('marks insufficientData when there are no read actions at all', async () => {
    const write = action({ safety: 'write' });
    const ctx: ProbeContext = { record: record({ actions: [write] }) };
    const result = await runErrorQuality(ctx);
    expect(result.insufficientData).toBe(true);
  });

  it('grades a readable "message" field as a pass', async () => {
    const invoke = fakeInvoke(() => ({
      status: 400,
      bodyText: JSON.stringify({ message: 'The id field is required and was not supplied.' }),
    }));
    const ctx: ProbeContext = { record: record(), invoke };
    const result = await runErrorQuality(ctx);
    expect(result.subscore).toBe(25);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0].payload).toMatchObject({ hasReadableMessage: true, sampleStatus: 400 });
  });

  it('finds a readable message nested one level deep', async () => {
    const invoke = fakeInvoke(() => ({
      status: 400,
      bodyText: JSON.stringify({ error: { detail: 'Missing required field: id in request path.' } }),
    }));
    const ctx: ProbeContext = { record: record(), invoke };
    const result = await runErrorQuality(ctx);
    expect(result.subscore).toBe(25);
  });

  it('grades an empty body as a fail', async () => {
    const invoke = fakeInvoke(() => ({ status: 400, bodyText: '' }));
    const ctx: ProbeContext = { record: record(), invoke };
    const result = await runErrorQuality(ctx);
    expect(result.subscore).toBe(0);
    expect(result.evidence[0].payload).toMatchObject({ hasReadableMessage: false });
  });

  it('grades an unparseable body as a fail', async () => {
    const invoke = fakeInvoke(() => ({ status: 400, bodyText: '<html>Bad Request</html>' }));
    const ctx: ProbeContext = { record: record(), invoke };
    const result = await runErrorQuality(ctx);
    expect(result.subscore).toBe(0);
  });

  it('grades a short message field as a fail (under 10 chars)', async () => {
    const invoke = fakeInvoke(() => ({ status: 400, bodyText: JSON.stringify({ message: 'bad' }) }));
    const ctx: ProbeContext = { record: record(), invoke };
    const result = await runErrorQuality(ctx);
    expect(result.subscore).toBe(0);
  });

  it('drops a required param from example params to corrupt the call', async () => {
    let seenArgs: Record<string, unknown> | undefined;
    const invoke: typeof invokeAction = async (_action, args) => {
      seenArgs = args;
      return { status: 400, latencyMs: 5, bodyText: JSON.stringify({ message: 'id is required in the path.' }) };
    };
    const ctx: ProbeContext = { record: record(), invoke };
    await runErrorQuality(ctx);
    expect(seenArgs).toEqual({});
  });

  it('falls back to mutating a path-placed param when there is no required array', async () => {
    const a = action({
      paramsSchema: { type: 'object', properties: { id: { type: 'string', 'x-spotcheck-in': 'path' } } },
      examples: [{ params: { id: 'abc' } }],
    });
    let seenArgs: Record<string, unknown> | undefined;
    const invoke: typeof invokeAction = async (_action, args) => {
      seenArgs = args;
      return { status: 404, latencyMs: 5, bodyText: JSON.stringify({ message: 'No thing found for that id.' }) };
    };
    const ctx: ProbeContext = { record: record({ actions: [a] }), invoke };
    await runErrorQuality(ctx);
    expect(seenArgs?.id).not.toBe('abc');
  });

  it('averages pass/fail across up to 2 sampled actions', async () => {
    const a1 = action({ id: 'a1', name: 'get_a' });
    const a2 = action({
      id: 'a2',
      name: 'get_b',
      path: '/b/{id}',
      paramsSchema: {
        type: 'object',
        properties: { id: { type: 'string', 'x-spotcheck-in': 'path' } },
        required: ['id'],
      },
      examples: [{ params: { id: 'xyz' } }],
    });
    const invoke: typeof invokeAction = async (action) => {
      if (action.id === 'a1') {
        return { status: 400, latencyMs: 5, bodyText: JSON.stringify({ message: 'A readable error message.' }) };
      }
      return { status: 400, latencyMs: 5, bodyText: '' };
    };
    const ctx: ProbeContext = { record: record({ actions: [a1, a2] }), invoke };
    const result = await runErrorQuality(ctx);
    expect(result.evidence).toHaveLength(2);
    expect(result.subscore).toBe(13); // 1 of 2 pass: round(0.5 * 25)
  });

  it('caps sampling at 2 actions even when more qualify', async () => {
    const actions = [
      action({ id: 'a1', name: 'get_a' }),
      action({ id: 'a2', name: 'get_b', path: '/b' }),
      action({ id: 'a3', name: 'get_c', path: '/c' }),
    ];
    const invoke = fakeInvoke(() => ({ status: 400, bodyText: JSON.stringify({ message: 'A readable message.' }) }));
    const ctx: ProbeContext = { record: record({ actions }), invoke };
    const result = await runErrorQuality(ctx);
    expect(result.evidence).toHaveLength(2);
  });

  it('treats a thrown error from invoke as a miss, without crashing', async () => {
    const invoke = (async () => {
      throw new Error('upstream unreachable');
    }) as typeof invokeAction;
    const ctx: ProbeContext = { record: record(), invoke };
    const result = await runErrorQuality(ctx);
    expect(result.subscore).toBe(0);
    expect(result.evidence[0].payload).toMatchObject({ hasReadableMessage: false, sampleStatus: 0 });
  });
});
