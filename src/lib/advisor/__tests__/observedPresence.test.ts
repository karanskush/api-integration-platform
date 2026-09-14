// describe_fields saying whether a response field actually shows up.

import { describe, expect, it } from 'vitest';
import { describeFields as raw } from '../fields';
import { checkFreshness } from '../changes';
import { action, ctx, type Payload } from './fixtures';

const listPets = () =>
  action({
    name: 'list_pets',
    method: 'GET',
    path: '/pets',
    responseSchema: {
      type: 'object',
      properties: {
        data: {
          type: 'array',
          items: { type: 'object', required: ['id', 'name'], properties: { id: { type: 'string' }, name: { type: 'string' } } },
        },
      },
    },
  });

const withShape = (presentName: number) =>
  ctx([listPets()], {
    observedShapes: [
      {
        actionId: 'id_list_pets',
        sampleCount: 3,
        observedAt: '2026-09-09T10:00:00.000Z',
        fields: [
          { path: 'response.data[].id', presentIn: 3, types: ['string'] },
          { path: 'response.data[].name', presentIn: presentName, types: ['string'] },
        ],
      },
    ],
  });

const responseField = (c: ReturnType<typeof ctx>, path: string) =>
  ((raw(c, { tool: 'list_pets', direction: 'response' }) as Payload).response as Payload[]).find((f) => f.path === path);

describe('observed presence on a response field', () => {
  it('reports a field seen in every sample as always present', () => {
    const observed = responseField(withShape(3), 'response.data[].id')?.observed as Payload;
    expect(observed).toMatchObject({ presentIn: 3, sampleCount: 3, always: true, observedAt: '2026-09-09T10:00:00.000Z' });
    expect(observed.note).toBeUndefined();
  });

  // The thing a spec cannot say and an integrator's null check must know.
  it('warns when a documented-required field was absent from sampled responses', () => {
    const observed = responseField(withShape(1), 'response.data[].name')?.observed as Payload;
    expect(observed.always).toBe(false);
    expect(observed.note).toContain('required but absent from 2 of 3');
  });

  it('is absent when nothing was observed, not defaulted', () => {
    expect(responseField(ctx([listPets()]), 'response.data[].id')?.observed).toBeUndefined();
  });

  it('never attaches to a request field', () => {
    const c = ctx([listPets()], { observedShapes: [{ actionId: 'id_list_pets', sampleCount: 3, observedAt: 'x', fields: [{ path: 'query.limit', presentIn: 3, types: ['integer'] }] }] });
    const out = raw(c, { tool: 'list_pets', direction: 'all' }) as Payload;
    expect(JSON.stringify(out.request ?? [])).not.toContain('"observed"');
  });
});

describe('check_freshness summarises what was observed', () => {
  it('counts sampled operations and rate-limit policies, and names the tightest policy', () => {
    const c = ctx([listPets()], {
      observedShapes: [{ actionId: 'id_list_pets', sampleCount: 3, observedAt: 'x', fields: [] }],
      rateLimits: [
        { actionId: 'id_list_pets', limit: 1000, windowSeconds: 3600, header: 'ratelimit-policy', observedAt: 'x' },
        { actionId: 'id_other', limit: 10, windowSeconds: 60, header: 'ratelimit-policy', observedAt: 'x' },
      ],
    });
    const observed = (checkFreshness(c) as Payload).observed as Payload;
    expect(observed.operationsSampled).toBe(1);
    expect(observed.operationsWithRateLimitPolicy).toBe(2);
    expect(observed.tightestRateLimit).toEqual({ limit: 10, windowSeconds: 60 });
  });

  it('reports zeros rather than omitting the block for an unobserved API', () => {
    const observed = (checkFreshness(ctx([listPets()])) as Payload).observed as Payload;
    expect(observed).toEqual({ operationsSampled: 0, operationsWithRateLimitPolicy: 0 });
  });
});
