import { describe, expect, it } from 'vitest';
import { describeFields as rawDescribeFields, traceField as rawTraceField } from '../fields';
import type { AdvisorContext } from '../types';
import { action, ctx, param, type Payload } from './fixtures';

type Args = Record<string, unknown>;
const describeFields = (c: AdvisorContext, a: Args): Payload => rawDescribeFields(c, a);
const traceField = (c: AdvisorContext, a: Args): Payload => rawTraceField(c, a);

// A small store: customers are listed and created, orders reference a customer
// by id, and signup invents a username.
function storeActions() {
  return [
    action({
      name: 'list_customers',
      method: 'GET',
      path: '/customers',
      paramsSchema: {
        type: 'object',
        properties: { cursor: param('query', 'string'), limit: param('query', 'integer') },
      },
      responseSchema: {
        type: 'object',
        properties: {
          data: {
            type: 'array',
            items: {
              type: 'object',
              properties: { customerId: { type: 'string', format: 'uuid' }, email: { type: 'string', format: 'email' } },
            },
          },
          next_cursor: { type: 'string' },
        },
      },
    }),
    action({
      name: 'create_order',
      method: 'POST',
      path: '/orders',
      safety: 'write',
      paramsSchema: {
        type: 'object',
        required: ['body'],
        properties: {
          body: param('body', 'object', {
            required: ['customerId', 'currency'],
            properties: {
              customerId: { type: 'string', format: 'uuid' },
              currency: { type: 'string', enum: ['usd', 'eur'] },
              note: { type: 'string', maxLength: 100 },
              orderId: { type: 'string', readOnly: true },
            },
          }),
        },
      },
      responseSchema: { type: 'object', properties: { orderId: { type: 'string' } } },
    }),
    action({
      name: 'signup',
      method: 'POST',
      path: '/signup',
      safety: 'write',
      paramsSchema: {
        type: 'object',
        required: ['body'],
        properties: {
          body: param('body', 'object', {
            required: ['username'],
            properties: { username: { type: 'string', minLength: 3 } },
          }),
        },
      },
    }),
  ];
}

const store = ctx(storeActions());

describe('describeFields', () => {
  it('requires a known tool', () => {
    expect(describeFields(store, {}).error).toContain('tool is required');
    expect(describeFields(store, { tool: 'nope' }).error).toContain('No operation named');
  });

  // The headline: a nested body becomes an addressable, constraint-bearing list.
  it('flattens a nested body into paths with constraints', () => {
    const res = describeFields(store, { tool: 'create_order' });
    const paths = res.request.map((f: Payload) => f.path);
    expect(paths).toContain('body.customerId');
    expect(paths).toContain('body.currency');

    const currency = res.request.find((f: Payload) => f.path === 'body.currency');
    expect(currency.allowed).toEqual(['usd', 'eur']);
    expect(currency.required).toBe(true);
  });

  it('hides server-assigned fields from the request view by default', () => {
    const res = describeFields(store, { tool: 'create_order' });
    expect(res.request.map((f: Payload) => f.path)).not.toContain('body.orderId');
    expect(res.summary.serverAssigned).toContain('body.orderId');
  });

  it('includes them on request', () => {
    const res = describeFields(store, { tool: 'create_order', includeReadOnly: true });
    expect(res.request.map((f: Payload) => f.path)).toContain('body.orderId');
  });

  it('labels each input with where its value comes from', () => {
    const res = describeFields(store, { tool: 'create_order' });
    const byPath = Object.fromEntries(res.request.map((f: Payload) => [f.path, f]));
    expect(byPath['body.customerId'].origin).toBe('produced_by_api');
    expect(byPath['body.currency'].origin).toBe('enum_constrained');
    expect(byPath['body.note'].origin).toBe('caller_supplied');
  });

  it('names the producing operation inline on a field', () => {
    const res = describeFields(store, { tool: 'create_order' });
    const customerId = res.request.find((f: Payload) => f.path === 'body.customerId');
    expect(customerId.from.map((p: Payload) => p.tool)).toContain('list_customers');
  });

  it('counts what is actually sendable', () => {
    const res = describeFields(store, { tool: 'create_order' });
    expect(res.summary.sendableFields).toBe(3); // customerId, currency, note
  });

  it('describes the response and error sides on request', () => {
    expect(describeFields(store, { tool: 'create_order', direction: 'response' }).response).toBeDefined();
    const all = describeFields(store, { tool: 'create_order', direction: 'all' });
    expect(all.request).toBeDefined();
    expect(all.response).toBeDefined();
    expect(all.error).toBeDefined();
  });

  it('filters by substring and reports what matched', () => {
    const res = describeFields(store, { tool: 'create_order', filter: 'curr' });
    expect(res.request.map((f: Payload) => f.path)).toEqual(['body.currency']);
    expect(res.summary.filter).toBe('curr');
  });

  it('clamps the limit', () => {
    expect(describeFields(store, { tool: 'create_order', limit: 1 }).request).toHaveLength(1);
    expect(() => describeFields(store, { tool: 'create_order', limit: 99_999 })).not.toThrow();
    expect(() => describeFields(store, { tool: 'create_order', limit: 'lots' })).not.toThrow();
  });

  it('surfaces the pagination model for a list operation', () => {
    const res = describeFields(store, { tool: 'list_customers' });
    expect(res.pagination.model).toBe('cursor');
    expect(res.pagination.cursorParam).toBe('cursor');
  });

  it('explains the origin vocabulary so the labels are self-describing', () => {
    expect(describeFields(store, { tool: 'signup' }).origins.caller_supplied).toContain('You must provide');
  });
});

describe('traceField', () => {
  it('requires a field argument', () => {
    expect(traceField(store, {}).error).toContain('field is required');
  });

  it('reports an unknown field rather than inventing one', () => {
    const res = traceField(store, { field: 'nonexistent_thing' });
    expect(res.error).toContain('appears anywhere');
    expect(res.hint).toContain('describe_fields');
  });

  // "Where is this coming from?"
  it('traces a body field back to the producing operation', () => {
    const res = traceField(store, { field: 'customerId', tool: 'create_order' });
    const hit = res.results.find((r: Payload) => r.field === 'body.customerId');
    expect(hit.origin).toBe('produced_by_api');
    expect(hit.producedBy.map((p: Payload) => p.tool)).toContain('list_customers');
    expect(hit.guidance).toContain('Do not fabricate');
  });

  // THE honest case: a value a human invents has no producer, and saying so is
  // the correct answer rather than a failure.
  it('reports a genuinely caller-supplied field as such', () => {
    const res = traceField(store, { field: 'username' });
    const hit = res.results.find((r: Payload) => r.tool === 'signup');
    expect(hit.origin).toBe('caller_supplied');
    expect(hit.producedBy).toEqual([]);
    expect(hit.guidance).toContain('originates with you');
  });

  // The reverse direction, which is how an agent plans forward.
  it('answers what consumes a value', () => {
    const res = traceField(store, { field: 'customerId', tool: 'list_customers' });
    const hit = res.results[0];
    expect(hit.consumedBy.map((c: Payload) => c.tool)).toContain('create_order');
  });

  it('honours the direction argument', () => {
    const producers = traceField(store, { field: 'customerId', tool: 'create_order', direction: 'producers' });
    expect(producers.results[0].producedBy).toBeDefined();
    expect(producers.results[0].consumedBy).toBeUndefined();

    const consumers = traceField(store, { field: 'customerId', tool: 'list_customers', direction: 'consumers' });
    expect(consumers.results[0].consumedBy).toBeDefined();
    expect(consumers.results[0].producedBy).toBeUndefined();
  });

  it('accepts a full path as well as a bare name', () => {
    const res = traceField(store, { field: 'body.customerId' });
    expect(res.results[0].field).toBe('body.customerId');
  });

  it('finds the field across every operation when no tool is given', () => {
    const res = traceField(store, { field: 'customerId' });
    expect(res.results.length).toBeGreaterThan(1);
    expect(res.matched).toBeGreaterThan(1);
  });

  it('rejects an unknown tool filter', () => {
    expect(traceField(store, { field: 'customerId', tool: 'nope' }).error).toContain('No operation named');
  });

  it('reports the evidence behind every link', () => {
    const res = traceField(store, { field: 'customerId', tool: 'create_order' });
    for (const producer of res.results[0].producedBy) {
      expect(producer.why.length).toBeGreaterThan(0);
      expect(['high', 'medium', 'low']).toContain(producer.confidence);
    }
  });

  it('states its basis and its default confidence policy', () => {
    const res = traceField(store, { field: 'customerId' });
    expect(res.basis).toContain('spec structure only');
    expect(res.note).toContain('do not invent one');
  });

  it('says so when low-confidence links are included', () => {
    const res = traceField(store, { field: 'customerId', includeLowConfidence: true });
    expect(res.note).toContain('Low-confidence');
  });

  it('tolerates junk argument types', () => {
    expect(() => traceField(store, { field: 42, tool: [], direction: {} })).not.toThrow();
  });
});
