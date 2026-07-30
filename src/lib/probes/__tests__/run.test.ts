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

describe('runScoreEngine', () => {
  it('sums all four subscores 1:1 when every probe has enough data', async () => {
    const withResponseSchema = action({ responseSchema: { type: 'object', properties: { id: { type: 'string' } } } });
    const record1 = record({ auth: 'none', actions: [withResponseSchema] });
    const invoke: typeof invokeAction = async () => ({
      status: 200,
      latencyMs: 5,
      bodyText: JSON.stringify({ id: 'abc' }),
    });
    const result = await runScoreEngine(record1, { invoke });
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
    const invoke: typeof invokeAction = async () => ({
      status: 200,
      latencyMs: 5,
      bodyText: JSON.stringify({ id: 'abc' }),
    });
    const result = await runScoreEngine(rec, { invoke });
    const kinds = result.evidence.map((e) => e.kind);
    expect(kinds).toContain('probe.error_quality');
    expect(kinds).toContain('probe.doc_drift');
    expect(kinds).toContain('probe.idempotency_signal');
  });
});
