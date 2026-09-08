// get_call_sequence reporting what was actually executed.
//
// Every other answer this server gives about call order is derived from schema
// structure, and says so. These tests fix the contract for the exception: when
// a chain really was run against the live API, the plan carries a receipt — and
// when it was not, it keeps saying so.

import { describe, expect, it } from 'vitest';
import { getCallSequence as rawGetCallSequence } from '../sequence';
import type { AdvisorContext, AdvisorInsights } from '../types';
import { action, ctx, param, type Payload } from './fixtures';

const getCallSequence = (c: AdvisorContext, a: Record<string, unknown>): Payload => rawGetCallSequence(c, a);

function storeActions() {
  return [
    action({
      name: 'list_customers',
      method: 'GET',
      path: '/v1/customers',
      responseSchema: {
        type: 'object',
        properties: {
          data: { type: 'array', items: { type: 'object', properties: { customerId: { type: 'string' } } } },
        },
      },
    }),
    action({
      name: 'get_customer',
      method: 'GET',
      path: '/v1/customers/{customerId}',
      paramsSchema: {
        type: 'object',
        required: ['customerId'],
        properties: { customerId: param('path') },
      },
    }),
  ];
}

function verdict(overrides: Partial<AdvisorInsights['lineageVerdicts'][number]> = {}) {
  return {
    key: 'list_customers.response.data[].customerId->get_customer.path.customerId',
    verdict: 'observed' as const,
    attempts: 2,
    successes: 2,
    stale: false,
    observedAt: '2026-09-08T10:00:00.000Z',
    ...overrides,
  };
}

const stepFor = (result: Payload, purpose: string): Payload | undefined =>
  (result.steps as Payload[]).find((s) => s.purpose === purpose);

describe('with nothing executed', () => {
  it('keeps saying the plan is spec-derived', () => {
    const result = getCallSequence(ctx(storeActions()), { tool: 'get_customer' });
    expect(result.derivedFrom).toBe('spec structure only — no live traffic was observed to build this plan');
  });

  it('marks no producer as verified', () => {
    const result = getCallSequence(ctx(storeActions()), { tool: 'get_customer' });
    expect(JSON.stringify(result)).not.toContain('verified');
  });
});

describe('with a confirmed execution', () => {
  const executed = () => ctx(storeActions(), { lineageVerdicts: [verdict()] });

  it('stops claiming no live traffic was observed', () => {
    const result = getCallSequence(executed(), { tool: 'get_customer' });

    expect(result.derivedFrom).not.toContain('no live traffic');
    expect(result.derivedFrom).toContain('confirmed by read-only execution');
  });

  it('attaches the receipt to the producer that earned it', () => {
    const result = getCallSequence(executed(), { tool: 'get_customer' });
    const obtain = stepFor(result, 'Obtain customerId');
    const producer = (obtain?.from as Payload[]).find((p) => p.tool === 'list_customers');

    expect(producer?.verified).toBe('observed');
    expect(producer?.detail).toContain('2 of 2');
    // The control is what separates this from a coincidence, so it is named.
    expect(producer?.detail).toContain('fabricated one was rejected');
  });

  it('dates the receipt so a reader can judge its age', () => {
    const result = getCallSequence(executed(), { tool: 'get_customer' });
    const producer = (stepFor(result, 'Obtain customerId')?.from as Payload[])[0];
    expect(producer.detail).toContain('2026-09-08');
  });
});

describe('with a refuted execution', () => {
  it('warns the agent off the link rather than quietly dropping it', () => {
    const c = ctx(storeActions(), { lineageVerdicts: [verdict({ verdict: 'refuted', successes: 0 })] });
    const producer = (stepFor(getCallSequence(c, { tool: 'get_customer' }), 'Obtain customerId')?.from as Payload[])[0];

    expect(producer.verified).toBe('refuted');
    expect(producer.detail).toContain('Do not rely on this link');
  });
});

describe('with an inconclusive execution', () => {
  // An attempt that proved nothing must not read as either a confirmation or a
  // refutation — it falls back to the spec-derived claim.
  it('says the attempt proved nothing either way', () => {
    const c = ctx(storeActions(), { lineageVerdicts: [verdict({ verdict: 'inconclusive' })] });
    const producer = (stepFor(getCallSequence(c, { tool: 'get_customer' }), 'Obtain customerId')?.from as Payload[])[0];

    expect(producer.verified).toBe('inconclusive');
    expect(producer.detail).toContain('proved nothing');
  });

  it('does not count toward the confirmed total in derivedFrom', () => {
    const c = ctx(storeActions(), { lineageVerdicts: [verdict({ verdict: 'inconclusive' })] });
    expect(getCallSequence(c, { tool: 'get_customer' }).derivedFrom).toContain('0 link(s) confirmed');
  });
});

describe('a receipt belongs to one link, not to an operation', () => {
  it('does not attach another operation-s receipt', () => {
    const c = ctx(storeActions(), {
      lineageVerdicts: [verdict({ key: 'list_orders.response.data[].orderId->get_order.path.orderId' })],
    });
    const producer = (stepFor(getCallSequence(c, { tool: 'get_customer' }), 'Obtain customerId')?.from as Payload[])[0];

    expect(producer.verified).toBeUndefined();
  });
});
