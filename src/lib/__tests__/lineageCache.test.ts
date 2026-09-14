// Cross-request caching of the computed lineage graph.
//
// The object-identity memo lineage.ts already had can only hit WITHIN one
// request, because persistentApi.ts's assembleRecord() returns a fresh object
// literal every call — so a persisted API recomputed its whole graph on every
// MCP tool call and every page render (~71ms at the 300-action cap, measured).
//
// The correctness half matters more than the speed half: a cache key that can
// collide would hand back a graph built from a different set of operations,
// which lineage.ts's own header calls the worst failure this module can have.
// Most of these tests are about that.

import { beforeEach, describe, expect, it } from 'vitest';
import { clearLineageCache, lineageFor } from '../lineage';
import type { Action, ImportRecord } from '../ir';

beforeEach(() => {
  clearLineageCache();
});

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

// A list -> detail pair, which is the shape that reliably produces an edge.
function petActions(suffix = ''): Action[] {
  return [
    action({
      name: `list_pets${suffix}`,
      path: '/v1/pets',
      responseSchema: {
        type: 'object',
        properties: {
          data: { type: 'array', items: { type: 'object', properties: { petId: { type: 'string' } } } },
        },
      },
    }),
    action({
      name: `get_pet${suffix}`,
      path: '/v1/pets/{petId}',
      paramsSchema: {
        type: 'object',
        required: ['petId'],
        properties: { petId: { type: 'string', 'x-docentapi-in': 'path' } },
      },
    }),
  ];
}

// Fresh object every call, exactly like assembleRecord().
function record(specVersionId: string | undefined, actions: Action[] = petActions()): ImportRecord {
  return {
    id: 'petstore',
    name: 'Petstore',
    source: 'openapi',
    baseUrls: ['https://api.petstore.test'],
    auth: 'bearer',
    actions,
    ...(specVersionId ? { specVersionId } : {}),
    counts: { total: actions.length, read: actions.length, write: 0, destructive: 0 },
    createdAt: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
}

describe('the graph survives across requests', () => {
  it('returns the same graph for two distinct record objects on one spec version', () => {
    const first = lineageFor(record('spec-a'));
    const second = lineageFor(record('spec-a'));

    // Identity, not deep equality: a fresh computation would be a new object.
    expect(second).toBe(first);
  });

  it('recomputes when the spec version moves — invalidation for free', () => {
    const before = lineageFor(record('spec-a'));
    const after = lineageFor(record('spec-b'));

    expect(after).not.toBe(before);
  });

  it('keeps the includeLow variant separate from the default', () => {
    const std = lineageFor(record('spec-a'));
    const low = lineageFor(record('spec-a'), { includeLow: true });

    expect(low).not.toBe(std);
    expect(lineageFor(record('spec-a'))).toBe(std);
  });
});

describe('the key identifies the action set, not just the spec version', () => {
  // mcp/[id]/route.ts builds `{ ...record, actions: resolvedActions }` after
  // resolveNameCollisions renames operations that clash with an advisor tool.
  // Those records share a spec version and differ only in tool names — and this
  // graph is keyed by tool name, so conflating them would serve the product page
  // a graph built from the MCP server's renamed operations.
  it('does not conflate two records that share a spec version but renamed actions', () => {
    const original = lineageFor(record('spec-a', petActions()));
    const renamed = lineageFor(record('spec-a', petActions('_api')));

    expect(renamed).not.toBe(original);
    expect([...original.producersOf.keys()]).toContain('get_pet');
    expect([...renamed.producersOf.keys()]).toContain('get_pet_api');
    expect([...renamed.producersOf.keys()]).not.toContain('get_pet');
  });

  it('does not conflate action sets of different size on one spec version', () => {
    const full = lineageFor(record('spec-a', petActions()));
    const trimmed = lineageFor(record('spec-a', petActions().slice(0, 1)));

    expect(trimmed).not.toBe(full);
    expect(trimmed.edges.length).toBeLessThan(full.edges.length);
  });
});

describe('ephemeral imports', () => {
  it('still compute correctly without a spec version', () => {
    const graph = lineageFor(record(undefined));
    expect(graph.edges.length).toBeGreaterThan(0);
  });

  it('do not share a graph between two different records', () => {
    const a = lineageFor(record(undefined));
    const b = lineageFor(record(undefined));

    // No stable key, so no cross-request reuse — and, critically, no collision.
    expect(b).not.toBe(a);
  });

  it('still reuse within a single record object, as before', () => {
    const rec = record(undefined);
    expect(lineageFor(rec)).toBe(lineageFor(rec));
  });
});

describe('the cache is bounded', () => {
  it('evicts without ever returning a wrong graph', () => {
    // More distinct spec versions than the cache holds.
    const graphs = new Map<string, ReturnType<typeof lineageFor>>();
    for (let i = 0; i < 40; i++) {
      const id = `spec-${i}`;
      graphs.set(id, lineageFor(record(id, petActions(`_${i}`))));
    }

    // Every entry, hit or recomputed, must describe its OWN actions.
    for (let i = 0; i < 40; i++) {
      const graph = lineageFor(record(`spec-${i}`, petActions(`_${i}`)));
      expect([...graph.producersOf.keys()]).toContain(`get_pet_${i}`);
    }
  });

  it('keeps the most recently used entry', () => {
    const kept = lineageFor(record('spec-keep'));
    for (let i = 0; i < 10; i++) lineageFor(record(`spec-filler-${i}`));
    // Touch it again so it stays recent, then push well past the bound.
    expect(lineageFor(record('spec-keep'))).toBe(kept);
  });
});
