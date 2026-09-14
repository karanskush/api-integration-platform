// The smallest valid body, tagged so the provider can recognise it.
import { describe, expect, it } from 'vitest';
import type { Action } from '../../ir';
import { synthesizeCreateBody, synthesizeUpdateBody } from '../bodySynth';

function withBody(schema: Record<string, unknown>, method = 'POST'): Action {
  return {
    id: 'c1',
    name: 'create_thing',
    description: '',
    method,
    path: '/things',
    paramsSchema: { type: 'object', required: ['body'], properties: { body: { ...schema, 'x-docentapi-in': 'body' } } },
    auth: 'bearer',
    safety: 'write',
    examples: [],
  } as Action;
}

describe('synthesizeCreateBody', () => {
  it('sends required properties only, tagged with the run', () => {
    const out = synthesizeCreateBody(
      withBody({ type: 'object', required: ['name'], properties: { name: { type: 'string' }, note: { type: 'string' } } }),
      'run1',
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.body).toEqual({ name: 'docentapi-probe-run1' });
    expect(out.tagged).toEqual(['name']);
  });

  it('takes the explicit example over anything it would invent', () => {
    const out = synthesizeCreateBody(withBody({ type: 'object', required: ['url'], properties: { url: { type: 'string', format: 'uri', example: 'https://example.com' } } }), 'r');
    expect(out).toMatchObject({ ok: true, body: { url: 'https://example.com' } });
  });

  it('never invents a URL', () => {
    const out = synthesizeCreateBody(withBody({ type: 'object', required: ['url'], properties: { url: { type: 'string', format: 'uri' } } }), 'r');
    expect(out).toEqual({ ok: false, reason: 'url_required' });
  });

  it('never guesses at a regex', () => {
    const out = synthesizeCreateBody(withBody({ type: 'object', required: ['code'], properties: { code: { type: 'string', pattern: '^[A-Z]{3}$' } } }), 'r');
    expect(out).toEqual({ ok: false, reason: 'pattern_required' });
  });

  it('picks the enum member least likely to mean "go live"', () => {
    const out = synthesizeCreateBody(withBody({ type: 'object', required: ['status'], properties: { status: { type: 'string', enum: ['published', 'draft'] } } }), 'r');
    expect(out).toMatchObject({ ok: true, body: { status: 'draft' } });
  });

  it('uses a reserved TLD for an email, so nobody receives anything', () => {
    const out = synthesizeCreateBody(withBody({ type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' } } }), 'r');
    expect(out.ok && String((out.body as { email: string }).email).endsWith('@example.invalid')).toBe(true);
  });

  it('respects minLength and maxLength on the tag', () => {
    const out = synthesizeCreateBody(withBody({ type: 'object', required: ['k'], properties: { k: { type: 'string', maxLength: 8 } } }), 'r');
    expect(out.ok && (out.body as { k: string }).k.length).toBe(8);
  });

  it('skips readOnly properties even when the spec lists them as required', () => {
    const out = synthesizeCreateBody(withBody({ type: 'object', required: ['id', 'name'], properties: { id: { type: 'string', readOnly: true }, name: { type: 'string' } } }), 'r');
    expect(out).toMatchObject({ ok: true, body: { name: 'docentapi-probe-r' } });
  });

  it('reports no_body for an operation without a body parameter', () => {
    const noBody = { ...withBody({}), paramsSchema: { type: 'object', properties: {} } } as Action;
    expect(synthesizeCreateBody(noBody, 'r')).toEqual({ ok: false, reason: 'no_body' });
  });
});

describe('synthesizeUpdateBody', () => {
  const update = withBody({ type: 'object', properties: { name: { type: 'string' }, color: { type: 'string' }, slug: { type: 'string' } } }, 'PATCH');

  it('changes one optional free-form string and names the marker to look for', () => {
    const out = synthesizeUpdateBody(update, { name: 'docentapi-probe-r' }, 'r');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.field).toBe('name');
    expect(out.marker).toContain('docentapi-probe-r');
    expect(out.body).toEqual({ name: out.marker });
  });

  it('re-sends the whole object for a PUT', () => {
    const put = { ...update, method: 'PUT' } as Action;
    const out = synthesizeUpdateBody(put, { name: 'x', color: 'red' }, 'r');
    expect(out.ok && (out.body as Record<string, unknown>).color).toBe('red');
  });

  it('refuses when only identifiers, enums or formatted strings are writable', () => {
    const only = withBody({ type: 'object', properties: { slug: { type: 'string' }, status: { type: 'string', enum: ['a', 'b'] } } }, 'PATCH');
    expect(synthesizeUpdateBody(only, {}, 'r')).toEqual({ ok: false, reason: 'no_optional_field' });
  });
});
