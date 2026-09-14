// Argument validation is the single gate in front of both the playground proxy
// and the MCP tools/call path, and — since Executed Lineage — in front of a
// chain step that sends a REAL production identifier.
//
// The compile cache used to be keyed on action.id, which normalize.ts derives
// as sha1(`${method} ${path}`).slice(0, 8) and documents as stable within an
// import, not unique across APIs. Two tenants exposing the same endpoint shape
// collided, and the cache is process-wide on a reused serverless instance.

import { describe, expect, it } from 'vitest';
import { validateParams } from '../validate';
import type { Action } from '../ir';

function action(id: string, paramsSchema: Record<string, unknown>): Action {
  return {
    id,
    name: `op_${id}`,
    description: 'x',
    method: 'GET',
    path: '/v1/customers/{customerId}',
    paramsSchema,
    auth: 'bearer',
    safety: 'read',
    examples: [],
  } as unknown as Action;
}

// The literal collision: sha1('GET /v1/customers/{customerId}') for both.
const SHARED_ID = 'a1b2c3d4';

describe('two APIs that share an endpoint shape do not share a validator', () => {
  const strict = action(SHARED_ID, {
    type: 'object',
    required: ['customerId'],
    properties: { customerId: { type: 'string' } },
  });

  const loose = action(SHARED_ID, {
    type: 'object',
    properties: { customerId: { type: 'string' } },
  });

  it('does not let the first API-s schema reject the second API-s valid call', () => {
    // Prime the cache with the schema that requires customerId.
    expect(validateParams(strict, {})).not.toBeNull();

    // The second API has the same action.id but does not require it.
    expect(validateParams(loose, {})).toBeNull();
  });

  it('does not let a lenient schema admit what a strict one forbids', () => {
    expect(validateParams(loose, {})).toBeNull();
    expect(validateParams(strict, {})).not.toBeNull();
  });

  it('still reports the offending field', () => {
    expect(validateParams(strict, {})).toContain('customerId');
  });
});

describe('ordinary behaviour is unchanged', () => {
  const a = action('deadbeef', {
    type: 'object',
    required: ['petId'],
    properties: { petId: { type: 'integer' } },
  });

  it('accepts valid params', () => {
    expect(validateParams(a, { petId: 7 })).toBeNull();
  });

  it('coerces a form-supplied string, as the proxy relies on', () => {
    expect(validateParams(a, { petId: '7' })).toBeNull();
  });

  it('returns null rather than throwing on a schema Ajv cannot compile', () => {
    const exotic = action('f00d', { type: 'object', properties: { x: { $ref: '#/nope' } } });
    expect(validateParams(exotic, { x: 1 })).toBeNull();
  });

  it('reuses the compiled validator for an identical schema', () => {
    const first = action('id_one', { type: 'object', required: ['q'], properties: { q: { type: 'string' } } });
    const second = action('id_two', { type: 'object', required: ['q'], properties: { q: { type: 'string' } } });

    expect(validateParams(first, {})).toBe(validateParams(second, {}));
  });
});
