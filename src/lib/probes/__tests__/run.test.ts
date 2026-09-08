import { describe, expect, it } from 'vitest';
import { runScoreEngine } from '../run';
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
    auth: 'apiKey',
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

const readableInvoke = (async () => ({
  status: 400,
  latencyMs: 5,
  bodyText: JSON.stringify({ message: 'The requested field is missing entirely.' }),
})) as typeof invokeAction;


// One stub that behaves like a real API, because the probes now require it to.
// errorQuality corrupts a request (it drops the required param, or poisons it)
// and needs a 4xx to have anything to grade; docDrift sends the documented
// example and needs a 2xx for its comparison to mean anything. A stub that
// answered 200 to everything used to satisfy both, which is exactly the
// blending this change removes.
const realisticInvoke: typeof invokeAction = async (_action, params) => {
  const p = (params ?? {}) as Record<string, unknown>;
  const corrupted = p.id === undefined || p.id === '__docentapi_invalid__';
  return corrupted
    ? { status: 400, latencyMs: 5, bodyText: JSON.stringify({ message: 'id is required' }) }
    : { status: 200, latencyMs: 5, bodyText: JSON.stringify({ id: 'abc' }) };
};

describe('runScoreEngine', () => {
  it('sums all four subscores 1:1 when every probe has enough data', async () => {
    const withResponseSchema = action({ responseSchema: { type: 'object', properties: { id: { type: 'string' } } } });
    const record1 = record({ auth: 'none', actions: [withResponseSchema] });
    const result = await runScoreEngine(record1, { invoke: realisticInvoke });
    expect(result.subscores.authClarity).toBe(25);
    expect(result.subscores.idempotency).toBe(25);
    expect(result.subscores.errorQuality).not.toBeNull();
    expect(result.subscores.docDrift).not.toBeNull();
  });

  it('renormalizes when one subscore (docDrift) is insufficientData', async () => {
    const write = action({
      id: 'w1',
      name: 'create_thing',
      method: 'POST',
      safety: 'write',
      paramsSchema: { type: 'object', properties: { amount: { type: 'number' } } },
      examples: [],
    });
    const read = action(); // no responseSchema -> docDrift insufficient
    const rec = record({ auth: 'apiKey', authIn: undefined, actions: [read, write] });

    const result = await runScoreEngine(rec, { invoke: readableInvoke });

    expect(result.subscores.docDrift).toBeNull();
    expect(result.subscores.authClarity).toBe(13); // apiKey, unresolved placement
    expect(result.subscores.errorQuality).toBe(25); // readable message -> pass
    expect(result.subscores.idempotency).toBe(0); // write action, no idempotency signal

    // ran = [13, 25, 0] over 3 subscores-max (75)
    const expectedTotal = Math.round(((13 + 25 + 0) / (3 * 25)) * 100);
    expect(result.total).toBe(expectedTotal);
    expect(result.total).toBe(51);
  });

  it('renormalizes when two subscores (docDrift and errorQuality) are insufficientData', async () => {
    const write = action({
      id: 'w1',
      name: 'create_thing',
      method: 'POST',
      safety: 'write',
      paramsSchema: { type: 'object', properties: { amount: { type: 'number' } } },
      examples: [],
    });
    const read = action({ examples: [] }); // no example params -> both errorQuality and docDrift insufficient
    const rec = record({ auth: 'apiKey', authIn: undefined, actions: [read, write] });

    const result = await runScoreEngine(rec, { invoke: readableInvoke });

    expect(result.subscores.docDrift).toBeNull();
    expect(result.subscores.errorQuality).toBeNull();
    expect(result.subscores.authClarity).toBe(13);
    expect(result.subscores.idempotency).toBe(0);

    // ran = [13, 0] over 2 subscores-max (50)
    const expectedTotal = Math.round(((13 + 0) / (2 * 25)) * 100);
    expect(result.total).toBe(expectedTotal);
    expect(result.total).toBe(26);
  });

  it('never punishes an API for a probe that could not run — insufficientData is excluded, not zeroed', async () => {
    const read = action({ examples: [] });
    const rec = record({ auth: 'none', actions: [read] }); // auth: none -> authClarity full marks, no write actions -> idempotency full marks
    const result = await runScoreEngine(rec, { invoke: readableInvoke });
    expect(result.subscores.errorQuality).toBeNull();
    expect(result.subscores.docDrift).toBeNull();
    expect(result.total).toBe(100); // (25 + 25) / (2 * 25) * 100, not (25+25+0+0)/100
  });

  it('concatenates evidence from all four probes', async () => {
    const withResponseSchema = action({ responseSchema: { type: 'object', properties: { id: { type: 'string' } } } });
    const write = action({
      id: 'w1',
      name: 'create_thing',
      method: 'POST',
      safety: 'write',
      paramsSchema: { type: 'object', properties: { amount: { type: 'number' } } },
      examples: [],
    });
    const rec = record({ auth: 'bearer', actions: [withResponseSchema, write] });
    const result = await runScoreEngine(rec, { invoke: realisticInvoke });
    const kinds = result.evidence.map((e) => e.kind);
    expect(kinds).toContain('probe.error_quality');
    expect(kinds).toContain('probe.doc_drift');
    expect(kinds).toContain('probe.idempotency_signal');
  });
});

// The accounting that makes a score admissible (GAP_ANALYSIS §0.2). Before it
// existed, a run where every call failed still produced a number, because
// authClarity computes its subscore before any I/O and idempotency makes no
// call at all.
describe('runScoreEngine live-call accounting', () => {
  it('counts every upstream call and how many actually succeeded', async () => {
    const withResponseSchema = action({ responseSchema: { type: 'object', properties: { id: { type: 'string' } } } });
    const rec = record({ auth: 'bearer', actions: [withResponseSchema] });

    const result = await runScoreEngine(rec, { invoke: realisticInvoke });

    expect(result.liveCalls.attempted).toBeGreaterThan(0);
    expect(result.liveCalls.succeeded).toBeGreaterThan(0);
    expect(result.liveCalls.attempted).toBe(result.liveCalls.succeeded + result.liveCalls.failed);
  });

  it('reports zero successes when the API is entirely unreachable', async () => {
    const withResponseSchema = action({ responseSchema: { type: 'object', properties: { id: { type: 'string' } } } });
    const rec = record({ auth: 'bearer', actions: [withResponseSchema] });
    const dead = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof invokeAction;

    const result = await runScoreEngine(rec, { invoke: dead });

    expect(result.liveCalls.succeeded).toBe(0);
    expect(result.liveCalls.failed).toBeGreaterThan(0);
    // The static subscores still compute — that is precisely the problem this
    // accounting exists to expose, rather than to hide.
    expect(result.subscores.authClarity).toBeGreaterThan(0);
  });

  it('counts a non-2xx as a failure, since no probe can measure on it', async () => {
    const withResponseSchema = action({ responseSchema: { type: 'object', properties: { id: { type: 'string' } } } });
    const rec = record({ auth: 'bearer', actions: [withResponseSchema] });
    const serverError = (async () => ({
      status: 500,
      latencyMs: 5,
      bodyText: '{"error":"boom"}',
    })) as typeof invokeAction;

    const result = await runScoreEngine(rec, { invoke: serverError });

    expect(result.liveCalls.succeeded).toBe(0);
    expect(result.liveCalls.attempted).toBeGreaterThan(0);
  });

  it('splits the total into what was observed and what was derived from the spec', async () => {
    const withResponseSchema = action({ responseSchema: { type: 'object', properties: { id: { type: 'string' } } } });
    const rec = record({ auth: 'bearer', actions: [withResponseSchema] });

    const result = await runScoreEngine(rec, { invoke: realisticInvoke });

    expect(result.points.observed + result.points.static).toBeLessThanOrEqual(result.points.max);
    // authClarity and idempotency are structural by construction, so there is
    // always a static component — the point is that it is now visible.
    expect(result.points.static).toBeGreaterThan(0);
  });
});
