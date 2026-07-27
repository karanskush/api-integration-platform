import { describe, expect, it } from 'vitest';
import { collectionPathFor, findProducers, getCallSequence as rawGetCallSequence, resourceOf } from '../sequence';
import type { AdvisorContext } from '../types';
import { action, ctx, param, petstoreActions, type Payload } from './fixtures';

const getCallSequence = (c: AdvisorContext, a: Record<string, unknown>): Payload => rawGetCallSequence(c, a);

describe('collectionPathFor', () => {
  it('returns the collection an identifier addresses an item within', () => {
    expect(collectionPathFor('/v1/pets/{petId}', 'petId')).toBe('/v1/pets');
  });

  it('keeps the parent identifier in a nested collection path', () => {
    expect(collectionPathFor('/v1/pets/{petId}/toys/{toyId}', 'toyId')).toBe('/v1/pets/{petId}/toys');
  });

  it('returns null for a parameter that is not in the path', () => {
    expect(collectionPathFor('/v1/pets', 'petId')).toBeNull();
  });
});

describe('resourceOf', () => {
  it('singularizes a plural collection segment', () => {
    expect(resourceOf('/v1/pets')).toBe('pet');
    expect(resourceOf('/v1/companies')).toBe('company');
    expect(resourceOf('/v1/addresses')).toBe('address');
    expect(resourceOf('/v1/boxes')).toBe('box');
  });

  // Nouns that merely end in s must survive intact, or the resource name
  // matches nothing downstream.
  it('leaves an already-singular segment alone', () => {
    expect(resourceOf('/v1/status')).toBe('status');
    expect(resourceOf('/v1/analysis')).toBe('analysis');
    expect(resourceOf('/v1/address')).toBe('address');
  });

  it('ignores path parameters when picking the resource', () => {
    expect(resourceOf('/v1/pets/{petId}/toys')).toBe('toy');
  });
});

describe('findProducers', () => {
  const actions = petstoreActions();
  const target = actions.find((a) => a.name === 'get_pet')!;

  it('offers the collection list as a high-confidence producer', () => {
    const producers = findProducers({ ...ctx(actions).record, actions }, target, 'petId');
    expect(producers[0]).toMatchObject({ tool: 'list_pets', confidence: 'high' });
  });

  it('offers the collection create as a producer too', () => {
    const producers = findProducers({ ...ctx(actions).record, actions }, target, 'petId');
    expect(producers.map((p) => p.tool)).toContain('create_pet');
  });

  it('prefers a read producer over a write one', () => {
    const producers = findProducers({ ...ctx(actions).record, actions }, target, 'petId');
    const listIndex = producers.findIndex((p) => p.tool === 'list_pets');
    const createIndex = producers.findIndex((p) => p.tool === 'create_pet');
    expect(listIndex).toBeLessThan(createIndex);
  });

  it('never suggests the target operation as its own producer', () => {
    const producers = findProducers({ ...ctx(actions).record, actions }, target, 'petId');
    expect(producers.map((p) => p.tool)).not.toContain('get_pet');
  });

  it('falls back to any operation documenting the field by name', () => {
    const custom = [
      action({
        name: 'whoami',
        method: 'GET',
        path: '/v1/me',
        responseSchema: { type: 'object', properties: { accountId: { type: 'string' } } },
      }),
      action({
        name: 'get_thing',
        method: 'GET',
        path: '/v1/things/{accountId}',
        paramsSchema: { type: 'object', required: ['accountId'], properties: { accountId: param('path') } },
      }),
    ];
    const target2 = custom[1];
    const producers = findProducers({ ...ctx(custom).record, actions: custom }, target2, 'accountId');
    expect(producers.map((p) => p.tool)).toContain('whoami');
    expect(producers.find((p) => p.tool === 'whoami')?.confidence).toBe('medium');
  });
});

describe('getCallSequence', () => {
  const context = ctx(petstoreActions());

  it('puts authentication first when the operation needs it', () => {
    const res = getCallSequence(context, { tool: 'get_pet' });
    expect(res.steps?.[0]).toMatchObject({ order: 1, purpose: 'Authenticate' });
  });

  it('omits the auth step for an unauthenticated API', () => {
    const open = ctx([action({ name: 'ping', method: 'GET', path: '/ping', auth: 'none' })]);
    const res = getCallSequence(open, { tool: 'ping' });
    expect(res.steps?.map((s: Payload) => s.purpose)).not.toContain('Authenticate');
  });

  it('adds a step resolving each path identifier, ending with the target call', () => {
    const res = getCallSequence(context, { tool: 'get_pet' });
    const purposes = res.steps?.map((s: Payload) => s.purpose);
    expect(purposes).toEqual(['Authenticate', 'Obtain petId', 'Call the target operation']);
  });

  it('resolves nested identifiers parent-first', () => {
    const res = getCallSequence(context, { tool: 'get_pet_toy' });
    const params = res.steps?.filter((s: Payload) => s.parameter).map((s: Payload) => s.parameter);
    expect(params).toEqual(['petId', 'toyId']);
  });

  it('names the operations that produce each identifier', () => {
    const res = getCallSequence(context, { tool: 'get_pet' });
    const step = res.steps?.find((s: Payload) => s.parameter === 'petId');
    expect((step?.from as Array<{ tool: string }>).map((f) => f.tool)).toContain('list_pets');
  });

  // The behaviour that keeps an agent from hallucinating an id.
  it('reports an untraceable identifier as unresolved instead of guessing', () => {
    const orphan = ctx([
      action({
        name: 'get_orphan',
        method: 'GET',
        path: '/v1/orphans/{orphanId}',
        paramsSchema: { type: 'object', required: ['orphanId'], properties: { orphanId: param('path') } },
      }),
    ]);
    const res = getCallSequence(orphan, { tool: 'get_orphan' });
    expect(res.unresolvedParameters).toEqual(['orphanId']);
    const step = res.steps?.find((s: Payload) => s.parameter === 'orphanId');
    expect(step?.detail).toContain('do not invent one');
    expect(res.notes?.some((n: string) => n.includes('caller-supplied'))).toBe(true);
  });

  it('traces a required id-shaped query parameter as well as path ones', () => {
    const actions = [
      action({
        name: 'list_invoices',
        method: 'GET',
        path: '/v1/invoices',
        paramsSchema: { type: 'object', required: ['customer_id'], properties: { customer_id: param('query') } },
      }),
      action({
        name: 'list_customers',
        method: 'GET',
        path: '/v1/customers',
        responseSchema: { type: 'array', items: { type: 'object', properties: { customer_id: { type: 'string' } } } },
      }),
    ];
    const res = getCallSequence(ctx(actions), { tool: 'list_invoices' });
    const step = res.steps?.find((s: Payload) => s.parameter === 'customer_id');
    expect(step).toBeDefined();
    expect((step?.from as Array<{ tool: string }>).map((f) => f.tool)).toContain('list_customers');
  });

  // Regression: the old ID_LIKE regex required a separator before the id token,
  // so camelCase query identifiers were never traced on any camelCase API.
  it('traces a camelCase id-shaped query parameter', () => {
    const actions = [
      action({
        name: 'list_invoices',
        method: 'GET',
        path: '/v1/invoices',
        paramsSchema: { type: 'object', required: ['customerId'], properties: { customerId: param('query') } },
      }),
      action({
        name: 'list_customers',
        method: 'GET',
        path: '/v1/customers',
        responseSchema: { type: 'array', items: { type: 'object', properties: { customerId: { type: 'string' } } } },
      }),
    ];
    const res = getCallSequence(ctx(actions), { tool: 'list_invoices' });
    const step = res.steps?.find((s: Payload) => s.parameter === 'customerId');
    expect(step).toBeDefined();
    expect((step?.from as Array<{ tool: string }>).map((f) => f.tool)).toContain('list_customers');
  });

  it('ignores a non-id query parameter', () => {
    const actions = [
      action({
        name: 'search',
        method: 'GET',
        path: '/v1/search',
        paramsSchema: { type: 'object', required: ['q'], properties: { q: param('query') } },
      }),
    ];
    const res = getCallSequence(ctx(actions), { tool: 'search' });
    expect(res.steps?.some((s: Payload) => s.parameter === 'q')).toBe(false);
  });

  it('lists the other required inputs on the final step', () => {
    const res = getCallSequence(context, { tool: 'update_pet' });
    const final = res.steps?.[res.steps.length - 1];
    expect((final?.alsoRequires as Array<{ name: string }>).map((r) => r.name)).toEqual(['body']);
  });

  it('warns that a destructive target needs human confirmation', () => {
    const res = getCallSequence(context, { tool: 'delete_pet' });
    expect(res.notes?.some((n: string) => n.includes('human confirmation'))).toBe(true);
  });

  it('warns more gently for a plain write', () => {
    const res = getCallSequence(context, { tool: 'create_pet' });
    expect(res.notes?.some((n: string) => n.includes('writes data'))).toBe(true);
  });

  it('cites observed auth behaviour when a probe recorded it', () => {
    const probed = ctx(petstoreActions(), { authObservations: [{ statusObserved: 401, expectedAuth: 'bearer' }] });
    const res = getCallSequence(probed, { tool: 'get_pet' });
    expect(res.steps?.[0].verified).toContain('401');
  });

  it('says outright that oauth2 cannot be completed from a pasted key', () => {
    const oauth = ctx([action({ name: 'x', method: 'GET', path: '/x', auth: 'oauth2' })]);
    const res = getCallSequence(oauth, { tool: 'x' });
    expect(res.steps?.[0].detail).toContain('OAuth2');
  });

  it('errors for an unknown tool and requires the argument', () => {
    expect(getCallSequence(context, { tool: 'nope' }).error).toContain('No operation named');
    expect(getCallSequence(context, {}).error).toContain('tool is required');
  });

  it('states that the plan is spec-derived, not traffic-derived', () => {
    expect(getCallSequence(context, { tool: 'get_pet' }).derivedFrom).toContain('spec structure only');
  });
});
