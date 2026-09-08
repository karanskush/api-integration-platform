// Which lineage edges can be verified by calling the API, and — more
// importantly — which must not be.
//
// The planner is where safety actually lives. It calls with a REAL identifier
// read out of the owner's production account, not with a fabricated spec
// example the way the canary does, so the eligibility rules here are stricter
// than `safety === 'read'` and every rejection is typed rather than silent.

import { describe, expect, it } from 'vitest';
import { buildExecutionPlan } from '../lineagePlan';
import type { Action, ImportRecord } from '../ir';

function action(overrides: Partial<Action> & { name: string; path: string }): Action {
  return {
    id: `id_${overrides.name}`,
    description: `Does ${overrides.name}`,
    method: 'GET',
    paramsSchema: { type: 'object', properties: {} },
    auth: 'bearer',
    safety: 'read',
    examples: [],
    ...overrides,
  } as Action;
}

function listCustomers(overrides: Partial<Action> = {}): Action {
  return action({
    name: 'list_customers',
    path: '/v1/customers',
    responseSchema: {
      type: 'object',
      properties: {
        data: { type: 'array', items: { type: 'object', properties: { customerId: { type: 'string' } } } },
      },
    },
    ...overrides,
  });
}

function getCustomer(overrides: Partial<Action> = {}): Action {
  return action({
    name: 'get_customer',
    path: '/v1/customers/{customerId}',
    paramsSchema: {
      type: 'object',
      required: ['customerId'],
      properties: { customerId: { type: 'string', 'x-docentapi-in': 'path' } },
    },
    ...overrides,
  });
}

function record(actions: Action[]): ImportRecord {
  return {
    id: 'store',
    name: 'Store',
    source: 'openapi',
    baseUrls: ['https://api.store.test'],
    auth: 'bearer',
    actions,
    counts: { total: actions.length, read: actions.length, write: 0, destructive: 0 },
    createdAt: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
}

const reasons = (plan: ReturnType<typeof buildExecutionPlan>) => plan.skipped.map((s) => s.reason);

describe('planning a verifiable chain', () => {
  it('plans a list -> detail chain', () => {
    const plan = buildExecutionPlan(record([listCustomers(), getCustomer()]));

    expect(plan.chains).toHaveLength(1);
    const [chain] = plan.chains;
    expect(chain.producer.name).toBe('list_customers');
    expect(chain.consumer.name).toBe('get_customer');
    expect(chain.consumerArg).toBe('customerId');
    expect(chain.consumerIn).toBe('path');
  });

  it('budgets a producer call, its candidates, and a control', () => {
    const plan = buildExecutionPlan(record([listCustomers(), getCustomer()]));
    // 1 producer + 2 candidates + 1 negative control.
    expect(plan.estimatedRequests).toBe(4);
  });

  it('is deterministic, so two runs are comparable', () => {
    const rec = () => record([listCustomers(), getCustomer()]);
    const a = buildExecutionPlan(rec()).chains.map((c) => c.edgeKey);
    const b = buildExecutionPlan(rec()).chains.map((c) => c.edgeKey);
    expect(a).toEqual(b);
  });
});

describe('what it refuses to execute', () => {
  it('refuses a consequential path even when it classifies as read', () => {
    // GET /accounts/{id}/close is `safety: 'read'` today, because safety is
    // derived from the HTTP method.
    const close = action({
      name: 'close_account',
      path: '/v1/customers/{customerId}/close',
      paramsSchema: {
        type: 'object',
        required: ['customerId'],
        properties: { customerId: { type: 'string', 'x-docentapi-in': 'path' } },
      },
    });
    const plan = buildExecutionPlan(record([listCustomers(), close]));

    expect(plan.chains.map((c) => c.consumer.name)).not.toContain('close_account');
    expect(reasons(plan)).toContain('dangerous_path');
  });

  it('refuses a non-GET producer, which a read-only executor cannot run', () => {
    const createCustomer = listCustomers({ name: 'create_customer', method: 'POST', safety: 'write' });
    const plan = buildExecutionPlan(record([createCustomer, getCustomer()]));

    expect(plan.chains).toHaveLength(0);
    expect(reasons(plan)).toContain('producer_not_get');
  });

  it('refuses a write consumer', () => {
    const updateCustomer = getCustomer({ name: 'update_customer', method: 'PUT', safety: 'write' });
    const plan = buildExecutionPlan(record([listCustomers(), updateCustomer]));

    expect(plan.chains).toHaveLength(0);
    expect(reasons(plan)).toContain('consumer_not_get');
  });

  it('refuses a destructive consumer outright', () => {
    const deleteCustomer = getCustomer({ name: 'delete_customer', method: 'DELETE', safety: 'destructive' });
    const plan = buildExecutionPlan(record([listCustomers(), deleteCustomer]));

    expect(plan.chains).toHaveLength(0);
  });

  it('refuses a consumer whose OTHER required params cannot be supplied', () => {
    const needsTwo = action({
      name: 'get_customer_invoice',
      path: '/v1/customers/{customerId}/invoices/{invoiceId}',
      paramsSchema: {
        type: 'object',
        required: ['customerId', 'invoiceId'],
        properties: {
          customerId: { type: 'string', 'x-docentapi-in': 'path' },
          invoiceId: { type: 'string', 'x-docentapi-in': 'path' },
        },
      },
      // No example, so invoiceId cannot be filled — guessing one would 404 and
      // we would then record that as evidence about the API.
      examples: [],
    });
    const plan = buildExecutionPlan(record([listCustomers(), needsTwo]));

    expect(plan.chains).toHaveLength(0);
    expect(reasons(plan)).toContain('consumer_params_unsatisfiable');
  });

  it('records a reason for every rejection rather than dropping it silently', () => {
    const plan = buildExecutionPlan(record([listCustomers({ method: 'POST', safety: 'write' }), getCustomer()]));
    expect(plan.skipped.length).toBeGreaterThan(0);
    for (const entry of plan.skipped) {
      expect(entry.edgeKey).toContain('->');
      expect(entry.reason).toBeTruthy();
    }
  });
});

describe('cost control on the producer call', () => {
  it('clamps a page size to one row', () => {
    const paginated = listCustomers({
      paramsSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', 'x-docentapi-in': 'query' },
          cursor: { type: 'string', 'x-docentapi-in': 'query' },
        },
      },
      examples: [{ params: { limit: 100, cursor: 'abc' } }],
    });
    const plan = buildExecutionPlan(record([paginated, getCustomer()]));

    expect(plan.chains[0].producerParams.limit).toBe(1);
    // Never walk a cursor: one row is all a chain needs.
    expect(plan.chains[0].producerParams.cursor).toBeUndefined();
  });
});

describe('caps', () => {
  it('stops at the chain cap and says so', () => {
    const actions = [listCustomers(), getCustomer()];
    for (let i = 0; i < 6; i++) {
      actions.push(
        action({
          name: `list_things_${i}`,
          path: `/v1/things${i}`,
          responseSchema: {
            type: 'object',
            properties: {
              data: { type: 'array', items: { type: 'object', properties: { [`thing${i}Id`]: { type: 'string' } } } },
            },
          },
        }),
        action({
          name: `get_thing_${i}`,
          path: `/v1/things${i}/{thing${i}Id}`,
          paramsSchema: {
            type: 'object',
            required: [`thing${i}Id`],
            properties: { [`thing${i}Id`]: { type: 'string', 'x-docentapi-in': 'path' } },
          },
        }),
      );
    }
    const plan = buildExecutionPlan(record(actions));

    expect(plan.chains.length).toBeLessThanOrEqual(3);
    expect(reasons(plan)).toContain('over_chain_cap');
  });
});

// Found by the first live runs. Both cost a real API its only executable chain,
// and neither would have surfaced from hand-built fixtures — the canary's live
// run taught the same lesson about itself.
describe('a required parameter the spec declares a value for', () => {
  it('is satisfiable from a default, without an example', () => {
    // Swagger Petstore v3: findPetsByStatus requires `status`, carries no
    // example, and declares default "available".
    const producer = listCustomers({
      paramsSchema: {
        type: 'object',
        required: ['status'],
        properties: {
          status: { type: 'string', default: 'available', enum: ['available', 'sold'], 'x-docentapi-in': 'query' },
        },
      },
      examples: [],
    });
    const plan = buildExecutionPlan(record([producer, getCustomer()]));

    expect(plan.chains).toHaveLength(1);
    expect(plan.chains[0].producerParams.status).toBe('available');
  });

  it('falls back to the first enum member when there is no default', () => {
    const producer = listCustomers({
      paramsSchema: {
        type: 'object',
        required: ['status'],
        properties: { status: { type: 'string', enum: ['pending', 'sold'], 'x-docentapi-in': 'query' } },
      },
      examples: [],
    });
    expect(buildExecutionPlan(record([producer, getCustomer()])).chains[0].producerParams.status).toBe('pending');
  });

  // Swagger 2 specs declare array parameters constantly, and the Petstore's own
  // findPetsByStatus is one: the values live on `items`, not on the property.
  it('reads a declared value off an array parameter-s items', () => {
    const producer = listCustomers({
      paramsSchema: {
        type: 'object',
        required: ['status'],
        properties: {
          status: {
            type: 'array',
            items: { type: 'string', enum: ['available', 'sold'], default: 'available' },
            'x-docentapi-in': 'query',
          },
        },
      },
      examples: [],
    });
    const plan = buildExecutionPlan(record([producer, getCustomer()]));

    expect(plan.chains).toHaveLength(1);
    expect(plan.chains[0].producerParams.status).toEqual(['available']);
  });

  it('still refuses when the spec declares nothing usable', () => {
    const producer = listCustomers({
      paramsSchema: {
        type: 'object',
        required: ['tenantId'],
        properties: { tenantId: { type: 'string', 'x-docentapi-in': 'query' } },
      },
      examples: [],
    });
    const plan = buildExecutionPlan(record([producer, getCustomer()]));

    expect(plan.chains).toHaveLength(0);
    expect(reasons(plan)).toContain('producer_params_unsatisfiable');
  });
});
