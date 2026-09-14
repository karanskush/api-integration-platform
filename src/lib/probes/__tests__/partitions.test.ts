import { describe, expect, it } from 'vitest';
import type { Action } from '../../ir';
import { fillParams } from '../../paramFill';
import { isValueRef, makeRef } from '../../transient';
import { buildNegativePartitions } from '../partitions';

function action(overrides: Partial<Action> = {}): Action {
  return {
    id: 'a1',
    name: 'list_things',
    description: '',
    method: 'GET',
    path: '/things',
    paramsSchema: { type: 'object', properties: {} },
    auth: 'none',
    safety: 'read',
    examples: [],
    ...overrides,
  };
}

const q = (props: Record<string, Record<string, unknown>>, required: string[] = [], examples: Record<string, unknown> = {}) =>
  action({
    paramsSchema: { type: 'object', properties: Object.fromEntries(Object.entries(props).map(([k, v]) => [k, { 'x-docentapi-in': 'query', ...v }])), required },
    examples: Object.keys(examples).length ? [{ params: examples }] : [],
  });

describe('buildNegativePartitions', () => {
  it('omits a required query parameter and sends it unvalidated', () => {
    const a = q({ q: { type: 'string' } }, ['q'], { q: 'shoes' });
    const [p] = buildNegativePartitions(a, fillParams(a));
    expect(p).toMatchObject({ kind: 'omitted_required', field: 'q', params: {}, validate: false });
  });

  it('never omits a path parameter — it fabricates an unknown id instead, and that request stays valid', () => {
    const a = action({
      path: '/things/{id}',
      paramsSchema: { type: 'object', properties: { id: { type: 'string', 'x-docentapi-in': 'path' } }, required: ['id'] },
      examples: [{ params: { id: 'thing_1' } }],
    });
    const parts = buildNegativePartitions(a, fillParams(a));
    expect(parts.map((p) => p.kind)).toEqual(['unknown_id']);
    expect(parts[0].validate).toBe(true);
    expect(parts[0].controlBasis).toBe('derived_placeholder');
    expect(isValueRef(parts[0].params.id)).toBe(true);
    expect(JSON.stringify(parts[0])).not.toContain('thing_1');
  });

  it('fabricates like the real id when the fill came from the pool', () => {
    const a = action({
      path: '/things/{id}',
      paramsSchema: { type: 'object', properties: { id: { type: 'string', 'x-docentapi-in': 'path' } }, required: ['id'] },
    });
    const base = { ok: true as const, params: { id: makeRef('cus_ABC123XYZ')! }, sources: { id: 'harvested' as const }, weakest: 'harvested' as const };
    const [p] = buildNegativePartitions(a, base);
    expect(p).toMatchObject({ kind: 'unknown_id', controlBasis: 'fabricated_like_real' });
    expect(JSON.stringify(p)).not.toContain('ABC123');
  });

  it('sends prose for a typed parameter, a stranger for an enum, and rubbish for a format — each unvalidated', () => {
    const a = q({ limit: { type: 'integer' }, status: { type: 'string', enum: ['a', 'b'] }, since: { type: 'string', format: 'date' } }, [], { limit: 5, status: 'a', since: '2024-01-01' });
    const parts = buildNegativePartitions(a, fillParams(a), { max: 6 });
    const byKind = Object.fromEntries(parts.map((p) => [p.kind, p]));
    expect(byKind.wrong_type.params.limit).toBe('docentapi-not-a-number');
    expect(byKind.enum_violation.params.status).toBe('__docentapi_not_in_enum__');
    expect(byKind.malformed_format.params.since).toBe('not-a-date');
    expect(parts.every((p) => p.validate === false)).toBe(true);
  });

  it('omits a required header as its own partition', () => {
    const a = action({
      paramsSchema: { type: 'object', properties: { 'X-Tenant': { type: 'string', 'x-docentapi-in': 'header' } }, required: ['X-Tenant'] },
      examples: [{ params: { 'X-Tenant': 't1' } }],
    });
    const parts = buildNegativePartitions(a, fillParams(a), { max: 6 });
    expect(parts.map((p) => p.kind)).toContain('missing_required_header');
    expect(parts.map((p) => p.kind)).not.toContain('omitted_required');
  });

  it('caps at two partitions by default, in priority order', () => {
    const a = q({ q: { type: 'string' }, limit: { type: 'integer' }, status: { type: 'string', enum: ['a', 'b'] } }, ['q'], { q: 'x', limit: 1, status: 'a' });
    expect(buildNegativePartitions(a, fillParams(a)).map((p) => p.kind)).toEqual(['omitted_required', 'wrong_type']);
  });

  it('builds nothing from an unfillable base or a parameterless read', () => {
    expect(buildNegativePartitions(action(), fillParams(action()))).toEqual([]);
    const unfillable = action({ path: '/things/{id}', paramsSchema: { type: 'object', properties: { id: { type: 'string', 'x-docentapi-in': 'path' } }, required: ['id'] } });
    expect(buildNegativePartitions(unfillable, fillParams(unfillable))).toEqual([]);
  });
});
