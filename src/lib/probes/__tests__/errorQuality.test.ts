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
      properties: { id: { type: 'string', 'x-docentapi-in': 'path' } },
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

  it('omits a required query parameter and sends the request with validation off', async () => {
    const a = action({
      path: '/things',
      paramsSchema: {
        type: 'object',
        properties: { q: { type: 'string', 'x-docentapi-in': 'query' } },
        required: ['q'],
      },
      examples: [{ params: { q: 'shoes' } }],
    });
    let seenArgs: Record<string, unknown> | undefined;
    let seenOpts: { validate?: boolean } | undefined;
    const invoke: typeof invokeAction = async (_action, args, _target, _key, opts) => {
      seenArgs = args;
      seenOpts = opts;
      return { status: 400, latencyMs: 5, bodyText: JSON.stringify({ message: 'q is required for this search.' }) };
    };
    const ctx: ProbeContext = { record: record({ actions: [a] }), invoke };
    await runErrorQuality(ctx);
    // The spec forbids this request; Ajv would have refused it client-side and
    // the probe would never have reached the wire — which is exactly what
    // happened in production before the validate option existed.
    expect(seenArgs).toEqual({});
    expect(seenOpts?.validate).toBe(false);
  });

  it('never omits a path parameter — a URL with a hole cannot be sent — and poisons it instead', async () => {
    let seenArgs: Record<string, unknown> | undefined;
    let seenOpts: { validate?: boolean } | undefined;
    const invoke: typeof invokeAction = async (_action, args, _target, _key, opts) => {
      seenArgs = args;
      seenOpts = opts;
      return { status: 404, latencyMs: 5, bodyText: JSON.stringify({ message: 'No thing found for that id.' }) };
    };
    const ctx: ProbeContext = { record: record(), invoke };
    await runErrorQuality(ctx);
    expect(seenArgs?.id).toBe('__docentapi_invalid__');
    expect(seenOpts?.validate).not.toBe(false);
  });

  it('falls back to mutating a path-placed param when there is no required array', async () => {
    const a = action({
      paramsSchema: { type: 'object', properties: { id: { type: 'string', 'x-docentapi-in': 'path' } } },
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
        properties: { id: { type: 'string', 'x-docentapi-in': 'path' } },
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

  // Previously counted as a miss AND recorded a fact with sampleStatus: 0,
  // which rendered to users as "returned an unreadable error on a 0 response" —
  // a description of an HTTP exchange that never happened.
  it('excludes an unreachable upstream instead of counting it as a miss', async () => {
    const invoke = (async () => {
      throw new Error('upstream unreachable');
    }) as typeof invokeAction;
    const result = await runErrorQuality({ record: record(), invoke });

    expect(result.insufficientData).toBe(true);
    expect(result.evidence.filter((e) => e.kind === 'probe.error_quality')).toHaveLength(0);
  });

  // This probe measures how good an API's ERRORS are. A 2xx means the corrupted
  // request was accepted, so there is no error to grade — and scoring it as a
  // pass rewarded the API for the opposite of what is measured.
  it('does not award a point for a 2xx carrying a message field', async () => {
    const invoke = (async () => ({
      status: 200,
      latencyMs: 5,
      bodyText: JSON.stringify({ message: 'Everything is fine, thanks for asking.' }),
    })) as typeof invokeAction;
    const result = await runErrorQuality({ record: record(), invoke });

    expect(result.insufficientData).toBe(true);
    expect(result.evidence.filter((e) => e.kind === 'probe.error_quality')).toHaveLength(0);
  });
});

describe('runErrorQuality lifecycle headers', () => {
  it('records lifecycle signals alongside the error grading', async () => {
    const result = await runErrorQuality({
      record: record(),
      invoke: (async () => ({
        status: 400,
        latencyMs: 3,
        bodyText: JSON.stringify({ message: 'Missing required parameter id' }),
        headers: { deprecation: '@1688169599', link: '<https://docs.example/d>; rel="deprecation"' },
      })) as typeof invokeAction,
    });

    const signals = result.evidence.filter((e) => e.kind === 'probe.lifecycle_signal');
    expect(signals.length).toBeGreaterThan(0);
    expect(signals[0].payload).toMatchObject({ kind: 'deprecated', url: 'https://docs.example/d' });
    // Grading is untouched: a readable message still earns full marks.
    expect(result.subscore).toBe(25);
  });
});

describe('an auth failure is not a validation error', () => {
  it('does not grade a 401 or 403 body as error quality', async () => {
    const invoke = fakeInvoke(() => ({ status: 401, bodyText: JSON.stringify({ message: 'Missing Authorization header, please sign in.' }) }));
    const result = await runErrorQuality({ record: record(), invoke });
    expect(result.insufficientData).toBe(true);
    expect(result.evidence.filter((e) => e.kind === 'probe.error_quality')).toEqual([]);
  });
});
