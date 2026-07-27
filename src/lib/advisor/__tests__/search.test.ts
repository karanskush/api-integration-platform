import { describe, expect, it } from 'vitest';
import { getEndpointSchema as rawGetEndpointSchema, searchEndpoints as rawSearchEndpoints } from '../search';
import type { AdvisorContext } from '../types';
import { action, ctx, param, petstoreActions, type Payload } from './fixtures';

type Args = Record<string, unknown>;
const searchEndpoints = (c: AdvisorContext, a: Args): Payload => rawSearchEndpoints(c, a);
const getEndpointSchema = (c: AdvisorContext, a: Args): Payload => rawGetEndpointSchema(c, a);

describe('searchEndpoints', () => {
  const context = ctx(petstoreActions());

  it('ranks an exact tool-name match first', () => {
    const res = searchEndpoints(context, { query: 'get_pet' });
    expect(res.results[0].tool).toBe('get_pet');
  });

  it('finds operations by resource noun', () => {
    const res = searchEndpoints(context, { query: 'toys' });
    expect(res.results.map((r: Payload) => r.tool)).toContain('list_pet_toys');
    expect(res.results.map((r: Payload) => r.tool)).toContain('get_pet_toy');
  });

  it('matches on description text', () => {
    const res = searchEndpoints(context, { query: 'permanently' });
    expect(res.results.map((r: Payload) => r.tool)).toContain('delete_pet');
  });

  it('boosts the operation whose HTTP method the query names', () => {
    const res = searchEndpoints(context, { query: 'create pet' });
    expect(res.results[0].tool).toBe('create_pet');
  });

  it('lists everything in a stable path order when no query is given', () => {
    const res = searchEndpoints(context, {});
    expect(res.returned).toBe(7);
    expect(res.results.map((r: Payload) => r.path)).toEqual([...res.results.map((r: Payload) => r.path)].sort());
  });

  it('honours the limit and reports how many matched overall', () => {
    const res = searchEndpoints(context, { query: 'pet', limit: 2 });
    expect(res.returned).toBe(2);
    expect(res.results).toHaveLength(2);
    expect(res.matched).toBeGreaterThan(2);
    expect(res.totalActions).toBe(7);
  });

  it('clamps an out-of-range limit instead of trusting it', () => {
    expect(searchEndpoints(context, { query: 'pet', limit: 9999 }).returned).toBeLessThanOrEqual(7);
    expect(searchEndpoints(context, { query: 'pet', limit: -5 }).returned).toBe(1);
    expect(searchEndpoints(context, { query: 'pet', limit: 'lots' }).returned).toBeGreaterThan(0);
  });

  it('filters by safety class', () => {
    const res = searchEndpoints(context, { query: 'pet', safety: 'destructive' });
    expect(res.results.map((r: Payload) => r.tool)).toEqual(['delete_pet']);
  });

  it('ignores an unrecognised safety value rather than returning nothing', () => {
    const res = searchEndpoints(context, { query: 'pet', safety: 'sorta-risky' });
    expect(res.results.length).toBeGreaterThan(1);
  });

  it('returns a usable hint when nothing matches', () => {
    const res = searchEndpoints(context, { query: 'zzzzz-nonexistent' });
    expect(res.results).toHaveLength(0);
    expect(res.hint).toContain('No operation matched');
  });

  it('still surfaces destructive operations, which are described but not callable', () => {
    const res = searchEndpoints(context, { query: 'delete' });
    expect(res.results[0]).toMatchObject({ tool: 'delete_pet', safety: 'destructive' });
  });
});

describe('getEndpointSchema', () => {
  const context = ctx(petstoreActions());

  it('returns parameters with their location and requiredness', () => {
    const res = getEndpointSchema(context, { tool: 'get_pet' });
    expect(res).toMatchObject({ tool: 'get_pet', method: 'GET', path: '/v1/pets/{petId}' });
    expect(res.parameters).toEqual([{ name: 'petId', in: 'path', type: 'string', required: true }]);
  });

  it('surfaces documented response and error schemas', () => {
    const res = getEndpointSchema(context, { tool: 'get_pet' });
    expect(res.responseSchema).toBeTruthy();
    expect(res.errorSchema).toBeTruthy();
  });

  it('reports the request body schema separately for write operations', () => {
    const res = getEndpointSchema(context, { tool: 'create_pet' });
    expect(res.requestBodySchema).toBeTruthy();
    expect(res.safety).toBe('write');
  });

  it('marks a destructive operation as not exposed over MCP', () => {
    const res = getEndpointSchema(context, { tool: 'delete_pet' });
    expect(res.exposedOverMcp).toBe(false);
  });

  it('flags GET as retry-safe from method semantics', () => {
    expect(getEndpointSchema(context, { tool: 'get_pet' }).retry).toMatchObject({
      retrySafe: 'safe',
      source: 'method_semantics',
    });
  });

  it('prefers an observed idempotency finding over method semantics', () => {
    const observed = ctx(petstoreActions(), {
      idempotencyObservations: [{ actionId: 'id_create_pet', hasIdempotencySignal: true, matchedParam: 'Idempotency-Key' }],
    });
    expect(getEndpointSchema(observed, { tool: 'create_pet' }).retry).toMatchObject({
      retrySafe: 'requires_key',
      idempotencyParam: 'Idempotency-Key',
      source: 'observed',
    });
  });

  it('reports POST retry safety as unknown when nothing was probed', () => {
    expect(getEndpointSchema(context, { tool: 'create_pet' }).retry).toMatchObject({
      retrySafe: 'unknown',
      source: 'not_probed',
    });
  });

  it('includes observed drift when a run recorded it', () => {
    const drifted = ctx(petstoreActions(), {
      driftObservations: [{ actionId: 'id_get_pet', matchedFields: 1, declaredFields: 2, mismatches: ['name'] }],
    });
    const res = getEndpointSchema(drifted, { tool: 'get_pet' });
    expect(res.observedDrift).toMatchObject({ matchedFields: 1, declaredFields: 2, mismatches: ['name'] });
  });

  it('notes the absence of a response schema instead of staying silent', () => {
    const res = getEndpointSchema(context, { tool: 'update_pet' });
    expect(res.responseSchema).toBeNull();
    expect(res.note).toContain('no response schema');
  });

  it('summarises the sendable fields inline, flattened from the body', () => {
    const res = getEndpointSchema(context, { tool: 'create_pet' });
    expect(res.fields.sendable.map((f: Payload) => f.path)).toContain('body.name');
    expect(res.fields.totalSendable).toBeGreaterThan(0);
  });

  it('separates server-assigned fields from sendable ones', () => {
    const withReadOnly = ctx([
      action({
        name: 'make_thing',
        method: 'POST',
        path: '/things',
        safety: 'write',
        paramsSchema: {
          type: 'object',
          properties: {
            body: param('body', 'object', {
              properties: { name: { type: 'string' }, id: { type: 'string', readOnly: true } },
            }),
          },
        },
      }),
    ]);
    const res = getEndpointSchema(withReadOnly, { tool: 'make_thing' });
    expect(res.fields.sendable.map((f: Payload) => f.path)).not.toContain('body.id');
    expect(res.fields.serverAssigned).toContain('body.id');
  });

  it('reports the pagination model for a list operation', () => {
    const paged = ctx([
      action({
        name: 'list_things',
        method: 'GET',
        path: '/things',
        paramsSchema: { type: 'object', properties: { cursor: param('query'), limit: param('query', 'integer') } },
      }),
    ]);
    expect(getEndpointSchema(paged, { tool: 'list_things' }).pagination.model).toBe('cursor');
  });

  it('omits pagination for an operation that does not paginate', () => {
    expect(getEndpointSchema(context, { tool: 'get_pet' }).pagination).toBeUndefined();
  });

  // These were echoed verbatim with no size limit, so one deeply nested body
  // could swamp the caller's context by itself.
  it('caps a very large raw schema instead of echoing it whole', () => {
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < 400; i++) {
      properties[`field${i}`] = { type: 'string', description: 'x'.repeat(60) };
    }
    const huge = ctx([
      action({ name: 'huge', method: 'GET', path: '/huge', responseSchema: { type: 'object', properties } }),
    ]);
    const res = getEndpointSchema(huge, { tool: 'huge' });
    expect(res.responseSchema.omitted).toBe(true);
    expect(res.responseSchema.use).toContain('describe_fields');
    expect(res.responseSchema.topLevelKeys.length).toBeGreaterThan(0);
  });

  it('still returns an ordinary schema inline', () => {
    expect(getEndpointSchema(context, { tool: 'get_pet' }).responseSchema.omitted).toBeUndefined();
  });

  it('errors with suggestions for an unknown tool', () => {
    const res = getEndpointSchema(context, { tool: 'get_pe' });
    expect(res.error).toContain('No operation named');
    expect(res.didYouMean).toContain('get_pet');
  });

  it('requires the tool argument', () => {
    expect(getEndpointSchema(context, {}).error).toContain('tool is required');
  });

  it('marks oauth2 as not satisfiable with a pasted key', () => {
    const oauth = ctx([action({ name: 'x', method: 'GET', path: '/x', auth: 'oauth2' })]);
    expect(getEndpointSchema(oauth, { tool: 'x' }).auth).toMatchObject({
      scheme: 'oauth2',
      satisfiableWithApiKey: false,
    });
  });

  it('defaults an unannotated parameter to query rather than dropping it', () => {
    const odd = ctx([
      action({
        name: 'odd',
        method: 'GET',
        path: '/odd',
        paramsSchema: { type: 'object', properties: { stray: { type: 'string' } } },
      }),
    ]);
    expect(getEndpointSchema(odd, { tool: 'odd' }).parameters).toEqual([
      { name: 'stray', in: 'query', type: 'string', required: false },
    ]);
  });

  it('reports enum values and descriptions for a parameter', () => {
    const withEnum = ctx([
      action({
        name: 'filtered',
        method: 'GET',
        path: '/filtered',
        paramsSchema: {
          type: 'object',
          properties: { status: param('query', 'string', { enum: ['open', 'closed'], description: 'Filter by status' }) },
        },
      }),
    ]);
    expect(getEndpointSchema(withEnum, { tool: 'filtered' }).parameters?.[0]).toMatchObject({
      enum: ['open', 'closed'],
      description: 'Filter by status',
    });
  });
});
