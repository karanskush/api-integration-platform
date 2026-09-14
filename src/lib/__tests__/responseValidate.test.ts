import { describe, expect, it } from 'vitest';
import { validateResponse } from '../responseValidate';

const schema = {
  type: 'object',
  required: ['id', 'count'],
  properties: { id: { type: 'string' }, count: { type: 'integer' }, when: { type: 'string', format: 'date-time' } },
} as const;

describe('validateResponse', () => {
  it('accepts a conforming body', () => {
    expect(validateResponse(schema, { id: 'a', count: 1 })).toEqual({ valid: true, errors: [] });
  });

  it('reports paths and keywords, never values', () => {
    const out = validateResponse(schema, { id: 'a', count: '1', when: 'yesterday' });
    expect(out.valid).toBe(false);
    expect(out.errors.map((e) => `${e.path}:${e.keyword}`).sort()).toEqual(['/count:type', '/when:format']);
    expect(JSON.stringify(out)).not.toContain('yesterday');
  });

  it('does not coerce: a number that arrived as a string is a finding', () => {
    expect(validateResponse({ type: 'object', properties: { n: { type: 'number' } } }, { n: '42' }).valid).toBe(false);
  });

  it('caps the error list', () => {
    const many = { type: 'object', properties: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${i}`, { type: 'integer' }])) };
    const body = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${i}`, 'x']));
    expect(validateResponse(many, body).errors).toHaveLength(20);
  });

  it('gives no judgement on a schema it cannot compile', () => {
    expect(validateResponse({ type: 'object', properties: { x: { type: 'not-a-type' } } } as never, {})).toEqual({ valid: null, errors: [] });
  });
});
