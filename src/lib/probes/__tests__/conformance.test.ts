// Read-side conformance over the invoke seam: a fabricated id, one OPTIONS per
// path, three pagination requests — and the safety rules around each.
import { describe, expect, it } from 'vitest';
import type { Action, ImportRecord } from '../../ir';
import type { invokeAction } from '../../mcpTools';
import { createBudget, withBudget } from '../budget';
import { runReadConformance } from '../conformance';

const detail: Action = {
  id: 'd1',
  name: 'get_thing',
  description: '',
  method: 'GET',
  path: '/things/{id}',
  paramsSchema: { type: 'object', properties: { id: { type: 'string', 'x-docentapi-in': 'path' } }, required: ['id'] },
  auth: 'none',
  safety: 'read',
  examples: [{ params: { id: 'thing_real' } }],
  errorSchema: { type: 'object', required: ['message'], properties: { message: { type: 'string' } } },
};

const list: Action = {
  id: 'l1',
  name: 'list_things',
  description: '',
  method: 'GET',
  path: '/things',
  paramsSchema: {
    type: 'object',
    properties: { cursor: { type: 'string', 'x-docentapi-in': 'query' }, limit: { type: 'integer', 'x-docentapi-in': 'query' } },
  },
  auth: 'none',
  safety: 'read',
  examples: [],
  responseSchema: {
    type: 'object',
    properties: {
      data: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } },
      next_cursor: { type: 'string' },
    },
  },
};

const create: Action = { ...detail, id: 'c1', name: 'create_thing', method: 'POST', path: '/things', safety: 'write', paramsSchema: { type: 'object', properties: {} }, examples: [] };

function record(actions: Action[]): ImportRecord {
  return {
    id: 'r',
    name: 'T',
    source: 'openapi',
    baseUrls: ['https://api.example.com'],
    auth: 'none',
    actions,
    counts: { total: actions.length, read: actions.filter((a) => a.safety === 'read').length, write: actions.filter((a) => a.safety !== 'read').length, destructive: 0 },
    createdAt: 0,
    expiresAt: 0,
  };
}

type Seen = { method: string; path: string; params: Record<string, unknown> };

// A small API: /things/{id} knows one record, /things paginates two pages by cursor.
function api(overrides: { allow?: string; softNotFound?: boolean; nextIsUrl?: boolean } = {}) {
  const seen: Seen[] = [];
  const invoke: typeof invokeAction = async (a, params) => {
    seen.push({ method: a.method, path: a.path, params: params as Record<string, unknown> });
    if (a.method === 'OPTIONS') {
      const headers: Record<string, string> = overrides.allow ? { allow: overrides.allow } : {};
      return { status: 204, latencyMs: 1, bodyText: '', headers };
    }
    if (a.path === '/things/{id}') {
      const id = (params as Record<string, unknown>).id;
      if (id === 'thing_real') return { status: 200, latencyMs: 1, bodyText: JSON.stringify({ id }) };
      return overrides.softNotFound
        ? { status: 200, latencyMs: 1, bodyText: JSON.stringify({ error: 'not found' }) }
        : { status: 404, latencyMs: 1, bodyText: JSON.stringify({ message: 'No such thing exists here.' }) };
    }
    const cursor = (params as Record<string, unknown>).cursor;
    if (cursor === undefined) {
      return { status: 200, latencyMs: 1, bodyText: JSON.stringify({ data: [{ id: 'one' }], next_cursor: overrides.nextIsUrl ? 'https://api.example.com/things?cursor=abc' : 'tok_2' }) };
    }
    return { status: 200, latencyMs: 1, bodyText: JSON.stringify({ data: [{ id: 'two' }], next_cursor: null }) };
  };
  return { invoke, seen };
}

describe('not_found_identity', () => {
  it('sends a fabricated id shaped like the example and records how the API answered', async () => {
    const { invoke, seen } = api();
    const report = await runReadConformance({ record: record([detail]), invoke });
    const fact = report.evidence.find((e) => e.kind === 'probe.not_found_identity');
    expect(fact?.payload).toMatchObject({ actionId: 'd1', status: 404, identity: 'not_found_404', controlBasis: 'derived_placeholder', matchesErrorSchema: true, hasReadableMessage: true });
    const control = seen.find((s) => s.path === '/things/{id}');
    expect(control?.params.id).not.toBe('thing_real');
    expect(JSON.stringify(report)).not.toContain('thing_real');
  });

  it('calls a 2xx to a made-up id what it is', async () => {
    const { invoke } = api({ softNotFound: true });
    const report = await runReadConformance({ record: record([detail]), invoke });
    expect(report.evidence.find((e) => e.kind === 'probe.not_found_identity')?.payload).toMatchObject({ identity: 'soft_404_2xx' });
  });
});

describe('method_support', () => {
  it('sends one OPTIONS per path and compares Allow with what the spec declares', async () => {
    const { invoke, seen } = api({ allow: 'GET, POST, DELETE, OPTIONS' });
    const report = await runReadConformance({ record: record([detail, create]), invoke });
    const facts = report.evidence.filter((e) => e.kind === 'probe.method_support');
    expect(facts).toHaveLength(1);
    // /things declares POST only via create; the detail path declares GET.
    expect(facts[0].payload).toMatchObject({ path: '/things/{id}', method: 'OPTIONS', allowHeaderPresent: true, allowDeclaredAgreement: 'allow_superset', undeclaredMethods: ['POST', 'DELETE'] });
    expect(seen.filter((s) => s.method === 'OPTIONS')).toHaveLength(1);
  });

  it('never sends a mutating method to discover support', async () => {
    const { invoke, seen } = api({ allow: 'GET' });
    await runReadConformance({ record: record([detail, list, create]), invoke });
    expect(seen.every((s) => s.method === 'GET' || s.method === 'OPTIONS')).toBe(true);
  });

  it('records the absence of an Allow header without inventing agreement', async () => {
    const { invoke } = api();
    const report = await runReadConformance({ record: record([detail]), invoke });
    expect(report.evidence.find((e) => e.kind === 'probe.method_support')?.payload).toMatchObject({ allowHeaderPresent: false, allowDeclaredAgreement: null, undeclaredMethods: [] });
  });
});

describe('pagination', () => {
  it('starts with one row, continues with the token, and reuses the cursor', async () => {
    const { invoke, seen } = api();
    const report = await runReadConformance({ record: record([list]), invoke });
    const fact = report.evidence.find((e) => e.kind === 'probe.pagination_behavior');
    expect(fact?.payload).toMatchObject({
      model: 'cursor',
      start: { status: 200, items: 1 },
      continue: { status: 200, advanced: true },
      cursorReuse: { status: 200, samePage: true },
    });
    // The method stage also sends one OPTIONS to this path; count the GETs.
    const calls = seen.filter((s) => s.path === '/things' && s.method === 'GET');
    expect(calls).toHaveLength(3);
    expect(calls[0].params).toEqual({ limit: 1 });
    expect(calls[1].params.cursor).toBe('tok_2');
    expect(JSON.stringify(report)).not.toContain('tok_2');
  });

  it('refuses to send a next value that is a URL', async () => {
    const { invoke, seen } = api({ nextIsUrl: true });
    const report = await runReadConformance({ record: record([list]), invoke });
    expect(report.evidence.find((e) => e.kind === 'probe.pagination_behavior')?.payload).toMatchObject({ skipped: 'next_is_url', continue: null });
    expect(seen.filter((s) => s.path === '/things' && s.method === 'GET')).toHaveLength(1);
  });

  it('is skipped, and says so, when the budget cannot cover three requests', async () => {
    const { invoke } = api();
    const budget = createBudget({ maxRequests: 2, deadlineMs: 60_000 });
    const report = await runReadConformance({ record: record([list]), invoke: withBudget(invoke, budget), budget });
    expect(report.substages.find((s) => s.stage === 'pagination')?.outcome).toBe('skipped_over_budget');
  });
});

describe('the report', () => {
  it('names every sub-stage, with no candidates when the spec offers none', async () => {
    const { invoke } = api();
    const report = await runReadConformance({ record: record([]), invoke });
    expect(report.substages.map((s) => `${s.stage}:${s.outcome}`)).toEqual([
      'not_found_identity:no_candidates',
      'method_support:no_candidates',
      'pagination:no_candidates',
    ]);
    expect(report.requests).toBe(0);
  });

  it('stops on a 429 and reports the later stages aborted', async () => {
    const invoke = (async () => ({ status: 429, latencyMs: 1, bodyText: '' })) as typeof invokeAction;
    const report = await runReadConformance({ record: record([detail, list]), invoke });
    expect(report.substages.map((s) => s.outcome)).toContain('aborted');
  });
});
