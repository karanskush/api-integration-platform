import type { Action, ImportRecord } from '../../ir';
import { emptyInsights, type AdvisorContext, type AdvisorInsights } from '../types';

// Advisor tools return one of several payload shapes (a result, or an `error`
// object), all of which are JSON-serialized straight to the caller. Tests
// assert on that JSON, so they read results through this loose view instead of
// narrowing the union at every call site — which would only add ceremony, not
// coverage. The implementations keep their precise inferred return types.
export type Payload = Record<string, any>;

type ActionOverrides = Partial<Action> & { name: string; method: string; path: string };

export function action(overrides: ActionOverrides): Action {
  return {
    id: `id_${overrides.name}`,
    description: `Does ${overrides.name}`,
    paramsSchema: { type: 'object', properties: {} },
    auth: 'bearer',
    safety: 'read',
    examples: [],
    ...overrides,
  } as Action;
}

// Property carrying the normalizer's 'x-spotcheck-in' annotation (see ir.ts).
export function param(
  where: 'path' | 'query' | 'header' | 'body',
  type = 'string',
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { type, 'x-spotcheck-in': where, ...extra };
}

export function record(overrides: Partial<ImportRecord> = {}): ImportRecord {
  return {
    id: 'petstore',
    name: 'Petstore',
    source: 'openapi',
    baseUrls: ['https://api.petstore.test/v1'],
    auth: 'bearer',
    actions: [],
    counts: { total: 0, read: 0, write: 0, destructive: 0 },
    createdAt: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
    ...overrides,
  };
}

export function ctx(actions: Action[], insights: Partial<AdvisorInsights> = {}): AdvisorContext {
  const counts = { total: actions.length, read: 0, write: 0, destructive: 0 };
  for (const a of actions) counts[a.safety]++;
  return {
    record: record({ actions, counts }),
    insights: { ...emptyInsights(), ...insights },
  };
}

// A small but realistic API: a collection with list/create, an item read, an
// item update, a nested collection, and a destructive delete.
export function petstoreActions(): Action[] {
  return [
    action({
      name: 'list_pets',
      method: 'GET',
      path: '/v1/pets',
      description: 'List all pets in the store',
      responseSchema: {
        type: 'array',
        items: { type: 'object', required: ['id', 'name'], properties: { id: { type: 'string' }, name: { type: 'string' }, tag: { type: 'string' } } },
      },
    }),
    action({
      name: 'create_pet',
      method: 'POST',
      path: '/v1/pets',
      safety: 'write',
      description: 'Create a pet',
      paramsSchema: {
        type: 'object',
        required: ['body'],
        properties: { body: param('body', 'object', { properties: { name: { type: 'string' } } }) },
      },
      responseSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, name: { type: 'string' } } },
    }),
    action({
      name: 'get_pet',
      method: 'GET',
      path: '/v1/pets/{petId}',
      description: 'Fetch one pet by id',
      paramsSchema: { type: 'object', required: ['petId'], properties: { petId: param('path') } },
      responseSchema: { type: 'object', required: ['id', 'name'], properties: { id: { type: 'string' }, name: { type: 'string' } } },
      errorSchema: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } },
    }),
    action({
      name: 'update_pet',
      method: 'PUT',
      path: '/v1/pets/{petId}',
      safety: 'write',
      description: 'Replace a pet',
      paramsSchema: {
        type: 'object',
        required: ['petId', 'body'],
        properties: { petId: param('path'), body: param('body', 'object') },
      },
    }),
    action({
      name: 'list_pet_toys',
      method: 'GET',
      path: '/v1/pets/{petId}/toys',
      description: 'List a pet’s toys',
      paramsSchema: { type: 'object', required: ['petId'], properties: { petId: param('path') } },
      responseSchema: { type: 'array', items: { type: 'object', required: ['toyId'], properties: { toyId: { type: 'string' } } } },
    }),
    action({
      name: 'get_pet_toy',
      method: 'GET',
      path: '/v1/pets/{petId}/toys/{toyId}',
      description: 'Fetch one toy belonging to a pet',
      paramsSchema: {
        type: 'object',
        required: ['petId', 'toyId'],
        properties: { petId: param('path'), toyId: param('path') },
      },
    }),
    action({
      name: 'delete_pet',
      method: 'DELETE',
      path: '/v1/pets/{petId}',
      safety: 'destructive',
      description: 'Permanently delete a pet',
      paramsSchema: { type: 'object', required: ['petId'], properties: { petId: param('path') } },
    }),
  ];
}
