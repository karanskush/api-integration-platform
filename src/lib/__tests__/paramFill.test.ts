// The one predicate behind "can this read be called": every probe used to
// answer it differently, and all of them read only the documented example.
// These tests pin the ladder, the refusals, and the Petstore case that exposed
// the gap — a spec with defaults and enums but not a single `example`.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Action, ImportRecord } from '../ir';
import { parseOpenApi } from '../importer/openapi';
import { normalizeOpenApi } from '../normalize';
import { canFill, createValuePool, deriveValue, fillParams, pooledFiller, producerParamsFor, specOnlyFiller } from '../paramFill';
import { makeRef } from '../transient';
import { validateParams } from '../validate';

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
      additionalProperties: false,
    },
    auth: 'none',
    safety: 'read',
    examples: [],
    ...overrides,
  };
}

const SPEC_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/petstore/openapi.json');

async function petstore(): Promise<ImportRecord> {
  const doc = await parseOpenApi(JSON.parse(readFileSync(SPEC_PATH, 'utf8')));
  const spec = normalizeOpenApi(doc, 'https://petstore3.swagger.io/api/v3/openapi.json');
  const counts = { total: spec.actions.length, read: 0, write: 0, destructive: 0 };
  for (const a of spec.actions) counts[a.safety]++;
  return {
    id: 'petstore-fixture',
    name: spec.name,
    source: 'openapi',
    baseUrls: spec.rawBaseUrls,
    auth: spec.auth,
    ...(spec.authIn ? { authIn: spec.authIn } : {}),
    actions: spec.actions,
    counts,
    createdAt: 1,
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
}

describe('the ladder', () => {
  it('uses the documented example before anything else', () => {
    const a = action({
      paramsSchema: {
        type: 'object',
        properties: { status: { type: 'string', enum: ['available', 'sold'], default: 'sold', 'x-docentapi-in': 'query' } },
        required: ['status'],
      },
      examples: [{ params: { status: 'available' } }],
    });
    const out = fillParams(a);
    expect(out).toMatchObject({ ok: true, params: { status: 'available' }, sources: { status: 'example' }, weakest: 'example' });
  });

  it('falls back to a schema example, then default, then const, then the first enum member', () => {
    const q = (schema: Record<string, unknown>) =>
      action({ paramsSchema: { type: 'object', properties: { p: { 'x-docentapi-in': 'query', ...schema } }, required: ['p'] } });
    expect(fillParams(q({ type: 'string', example: 'ex', default: 'def', enum: ['def', 'x'] }))).toMatchObject({ params: { p: 'ex' }, weakest: 'schema_example' });
    expect(fillParams(q({ type: 'string', default: 'def', enum: ['x', 'def'] }))).toMatchObject({ params: { p: 'def' }, weakest: 'default' });
    expect(fillParams(q({ type: 'string', const: 'only' }))).toMatchObject({ params: { p: 'only' }, weakest: 'const' });
    expect(fillParams(q({ type: 'string', enum: ['first', 'second'] }))).toMatchObject({ params: { p: 'first' }, weakest: 'enum' });
  });

  it('reads a declared value off an array parameter-s items, as Swagger 2 specs declare them', () => {
    const a = action({
      paramsSchema: {
        type: 'object',
        properties: { status: { type: 'array', items: { type: 'string', enum: ['available', 'pending'], default: 'available' }, 'x-docentapi-in': 'query' } },
        required: ['status'],
      },
    });
    expect(fillParams(a)).toMatchObject({ ok: true, params: { status: ['available'] } });
  });

  it('derives a tagged placeholder for a required non-id string and reports it as the weakest rung', () => {
    const a = action({
      path: '/search',
      paramsSchema: { type: 'object', properties: { q: { type: 'string', 'x-docentapi-in': 'query' } }, required: ['q'] },
    });
    const out = fillParams(a, { runId: 'r1' });
    expect(out).toMatchObject({ ok: true, params: { q: 'docentapi-probe-r1' }, weakest: 'derived' });
  });

  it('fills a read with no parameters — a list endpoint is callable', () => {
    const a = action({ path: '/things', paramsSchema: { type: 'object', properties: {} } });
    expect(fillParams(a)).toEqual({ ok: true, params: {}, sources: {}, weakest: null });
  });
});

describe('what it refuses to invent', () => {
  it('never guesses a path identifier', () => {
    expect(fillParams(action())).toEqual({ ok: false, reason: 'placeholder_id_refused', missing: ['id'] });
    expect(canFill(action())).toBe(false);
  });

  it('never guesses an id-shaped query parameter either', () => {
    const a = action({
      path: '/orders',
      paramsSchema: { type: 'object', properties: { customerId: { type: 'string', 'x-docentapi-in': 'query' } }, required: ['customerId'] },
    });
    expect(fillParams(a)).toMatchObject({ ok: false, reason: 'placeholder_id_refused' });
  });

  it('guesses an id only when a caller opts in', () => {
    const out = fillParams(action(), { allowPlaceholderIds: true, runId: 'r1' });
    expect(out).toMatchObject({ ok: true, params: { id: 'docentapi-probe-r1' }, weakest: 'derived' });
  });

  it('never invents a URL', () => {
    const a = action({
      path: '/fetch',
      paramsSchema: { type: 'object', properties: { url: { type: 'string', format: 'uri', 'x-docentapi-in': 'query' } }, required: ['url'] },
    });
    expect(fillParams(a)).toMatchObject({ ok: false, reason: 'url_like_value' });
  });

  it('never invents a regex match', () => {
    const a = action({
      path: '/lookup',
      paramsSchema: { type: 'object', properties: { region: { type: 'string', pattern: '^[A-Z]{2}-[A-Z]{3}$', 'x-docentapi-in': 'query' } }, required: ['region'] },
    });
    expect(fillParams(a)).toMatchObject({ ok: false, reason: 'pattern_unsatisfiable' });
  });

  it('refuses a required parameter the schema does not even declare', () => {
    const a = action({ path: '/x', paramsSchema: { type: 'object', properties: {}, required: ['ghost'] } });
    expect(fillParams(a)).toMatchObject({ ok: false, reason: 'unfillable_required', missing: ['ghost'] });
  });

  it('drops example keys the schema does not declare, so Ajv never rejects the fill', () => {
    const a = action({
      path: '/things',
      paramsSchema: { type: 'object', properties: { q: { type: 'string', 'x-docentapi-in': 'query' } }, additionalProperties: false },
      examples: [{ params: { q: 'a', stray: 'b' } }],
    });
    const out = fillParams(a);
    expect(out.ok && out.params).toEqual({ q: 'a' });
  });
});

describe('pagination discipline', () => {
  const list = action({
    path: '/things',
    paramsSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 5, maximum: 50, 'x-docentapi-in': 'query' },
        cursor: { type: 'string', 'x-docentapi-in': 'query' },
      },
    },
    examples: [{ params: { limit: 100, cursor: 'somebody-elses-position' } }],
  });

  it('clamps the page size to one row within the declared bounds and never sends a cursor', () => {
    const out = fillParams(list);
    expect(out.ok && out.params).toEqual({ limit: 5 });
  });

  it('asks for a bigger page when a probe needs repetition', () => {
    const out = fillParams(list, { pageSize: 25 });
    expect(out.ok && out.params).toEqual({ limit: 25 });
    const capped = fillParams(list, { pageSize: 500 });
    expect(capped.ok && capped.params).toEqual({ limit: 50 });
  });

  it('producerParamsFor is deterministic and one row', () => {
    expect(producerParamsFor(list)).toEqual({ limit: 5 });
  });
});

describe('the pool', () => {
  const detail = action();

  it('fills an id from a harvested value, as a ValueRef that never stringifies', () => {
    const pool = createValuePool();
    pool.add('get_thing', 'id', [{ ref: makeRef('thing_123')!, source: 'harvested' }]);
    const out = pooledFiller(pool)(detail);
    expect(out).toMatchObject({ ok: true, sources: { id: 'harvested' }, weakest: 'harvested' });
    expect(JSON.stringify(out)).not.toContain('thing_123');
  });

  it('is ignored when a caller asks for determinism (the canary)', () => {
    const pool = createValuePool();
    pool.add('get_thing', 'id', [{ ref: makeRef('thing_123')!, source: 'harvested' }]);
    expect(fillParams(detail, { pool, deterministic: true })).toMatchObject({ ok: false, reason: 'placeholder_id_refused' });
  });

  it('is never consulted by the spec-only filler', () => {
    const pool = createValuePool();
    pool.add('get_thing', 'id', [{ ref: makeRef('thing_123')!, source: 'harvested' }]);
    expect(specOnlyFiller(detail, { pool })).toMatchObject({ ok: false });
  });

  it('leaves the excluded argument to the caller', () => {
    const out = fillParams(detail, { exclude: 'id' });
    expect(out).toEqual({ ok: true, params: {}, sources: {}, weakest: null });
  });
});

describe('derived values are schema-shaped', () => {
  it('respects numeric bounds', () => {
    expect(deriveValue('n', { type: 'integer', minimum: 10 })).toBe(10);
    expect(deriveValue('n', { type: 'integer', minimum: 10, exclusiveMinimum: true })).toBe(11);
    expect(deriveValue('n', { type: 'number', maximum: -3 })).toBe(-3);
  });

  it('respects string length bounds', () => {
    expect(deriveValue('s', { type: 'string', maxLength: 5 }, { runId: 'r' })).toHaveLength(5);
    expect((deriveValue('s', { type: 'string', minLength: 40 }, { runId: 'r' }) as string).length).toBe(40);
  });

  it('is stable across runs when asked to be', () => {
    expect(deriveValue('u', { type: 'string', format: 'uuid' }, { deterministic: true })).toBe(
      deriveValue('u', { type: 'string', format: 'uuid' }, { deterministic: true }),
    );
  });

  it('fails closed on an object whose required child it cannot derive', () => {
    expect(
      deriveValue('o', { type: 'object', required: ['link'], properties: { link: { type: 'string', format: 'uri' } } }),
    ).toBeUndefined();
  });
});

describe('against the Swagger Petstore, which declares defaults and enums but no example', () => {
  it('can now call findPetsByStatus from its declared default, and never guesses getPetById-s id', async () => {
    const record = await petstore();
    const byName = new Map(record.actions.map((a) => [a.name, a]));
    const findByStatus = byName.get('find_pets_by_status')!;
    const getById = byName.get('get_pet_by_id')!;
    expect(findByStatus.examples).toEqual([]);

    const filled = fillParams(findByStatus);
    expect(filled.ok).toBe(true);
    expect(filled.ok && filled.params.status).toBe('available');
    expect(fillParams(getById)).toMatchObject({ ok: false, reason: 'placeholder_id_refused' });

    const pool = createValuePool();
    pool.add('get_pet_by_id', 'petId', [{ ref: makeRef(10)!, source: 'harvested' }]);
    expect(pooledFiller(pool)(getById).ok).toBe(true);
  });

  it('produces params Ajv accepts for every read it can fill', async () => {
    const record = await petstore();
    let filled = 0;
    for (const a of record.actions) {
      if (a.safety !== 'read') continue;
      const out = fillParams(a);
      if (!out.ok) continue;
      filled++;
      expect(validateParams(a, out.params)).toBeNull();
    }
    expect(filled).toBeGreaterThan(0);
  });
});
