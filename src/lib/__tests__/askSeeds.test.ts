import { describe, expect, it } from 'vitest';
import { suggestedQuestions } from '../askSeeds';
import type { Action, ImportRecord } from '../ir';

function action(o: Partial<Action> & { name: string; method: string; path: string }): Action {
  return {
    id: `id_${o.name}`,
    description: `Does ${o.name}`,
    paramsSchema: { type: 'object', properties: {} },
    auth: 'none',
    safety: 'read',
    examples: [],
    ...o,
  } as Action;
}

function record(actions: Action[]): ImportRecord {
  return { name: 'Petstore', source: 'openapi', baseUrls: [], auth: 'none', actions } as unknown as ImportRecord;
}

const petstore = record([
  action({
    name: 'get_pet_by_id',
    method: 'GET',
    path: '/pet/{petId}',
    paramsSchema: {
      type: 'object',
      required: ['petId'],
      properties: { petId: { type: 'integer', 'x-docentapi-in': 'path' } },
    },
  }),
  action({
    name: 'add_pet',
    method: 'POST',
    path: '/pet',
    safety: 'write',
    paramsSchema: {
      type: 'object',
      required: ['body'],
      properties: {
        body: {
          'x-docentapi-in': 'body',
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' }, status: { type: 'string' } },
        },
      },
    },
  }),
]);

describe('suggestedQuestions', () => {
  // The point of deriving seeds instead of hardcoding copy: they have to name
  // this API's real endpoints and fields, or they teach nothing about what the
  // advisor tools can actually answer.
  it('names a real path parameter and a real write endpoint', () => {
    const seeds = suggestedQuestions(petstore);
    const questions = seeds.map((s) => s.question);
    expect(questions).toContain('Where does petId come from?');
    expect(questions).toContain('What do I need to call before add_pet?');
    expect(seeds.every((s) => s.question.length > 0)).toBe(true);
  });

  it('caps at three so the empty state stays scannable', () => {
    expect(suggestedQuestions(petstore).length).toBeLessThanOrEqual(3);
  });

  it('carries the endpoint each seed is about, for the hint', () => {
    const seed = suggestedQuestions(petstore).find((s) => s.question.includes('petId'));
    expect(seed?.tool).toBe('get_pet_by_id');
  });

  // A read-only API still needs a populated empty state; a blank box is the
  // failure this whole module exists to prevent.
  it('falls back to a read and an API-level question when there is no write', () => {
    const seeds = suggestedQuestions(
      record([action({ name: 'list_pets', method: 'GET', path: '/pets' })]),
    );
    expect(seeds.length).toBeGreaterThan(0);
    expect(seeds.map((s) => s.question)).toContain('What does list_pets return?');
  });

  it('returns nothing rather than inventing questions for an empty API', () => {
    expect(suggestedQuestions(record([]))).toEqual([]);
  });

  // Prefers the write with the most parameters: a write with prerequisites and
  // required fields is where the DAG and the field graph pay off, a bare one is
  // no more instructive than a GET.
  it('prefers the richest write endpoint', () => {
    const seeds = suggestedQuestions(
      record([
        action({ name: 'ping', method: 'POST', path: '/ping', safety: 'write' }),
        action({
          name: 'place_order',
          method: 'POST',
          path: '/orders',
          safety: 'write',
          paramsSchema: {
            type: 'object',
            properties: { a: { type: 'string' }, b: { type: 'string' }, c: { type: 'string' } },
          },
        }),
      ]),
    );
    expect(seeds.some((s) => s.tool === 'place_order')).toBe(true);
    expect(seeds.some((s) => s.tool === 'ping')).toBe(false);
  });
});
