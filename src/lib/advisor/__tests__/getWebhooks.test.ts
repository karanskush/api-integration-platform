// docentapi_get_webhooks — the events this API emits, declared not observed.

import { describe, expect, it } from 'vitest';
import { getWebhooks } from '../webhooks';
import type { Webhook } from '../../ir';
import { action, ctx, type Payload } from './fixtures';

const NEWLINE = String.fromCharCode(10);

const hooks: Webhook[] = [
  {
    name: 'order.created',
    method: 'POST',
    description: 'An order was placed',
    source: 'webhooks',
    payloadSchema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' }, amount: { type: 'integer' } },
    },
  },
  { name: 'onEvent', method: 'POST', description: 'Event delivered', source: 'callback', callbackOf: 'create_subscription' },
];

const withHooks = (webhooks: Webhook[] = hooks) => {
  const c = ctx([action({ name: 'create_subscription', method: 'POST', path: '/subscriptions', safety: 'write' })]);
  return { ...c, record: { ...c.record, webhooks } };
};

describe('listing', () => {
  it('summarizes every declared event with its top-level payload fields', () => {
    const out = getWebhooks(withHooks(), {}) as Payload;
    expect(out.count).toBe(2);
    expect((out.webhooks as Payload[])[0]).toEqual({
      name: 'order.created',
      method: 'POST',
      description: 'An order was placed',
      declaredAs: 'webhook',
      payloadFields: [
        { name: 'id', type: 'string', required: true },
        { name: 'amount', type: 'integer', required: false },
      ],
    });
    expect((out.webhooks as Payload[])[1]).toMatchObject({ declaredAs: 'callback', registeredBy: 'create_subscription' });
  });

  it('says plainly that nothing was observed', () => {
    expect(String((getWebhooks(withHooks(), {}) as Payload).basis)).toContain('no delivery was observed');
  });

  it('answers an undeclared API honestly rather than with an empty list alone', () => {
    const out = getWebhooks(ctx([action({ name: 'x', method: 'GET', path: '/x' })]), {}) as Payload;
    expect(out.count).toBe(0);
    expect(String(out.note)).toContain('may still emit events it does not document');
  });
});

describe('one webhook', () => {
  it('returns the full payload schema', () => {
    const out = getWebhooks(withHooks(), { name: 'order.created' }) as Payload;
    expect(out.payloadSchema).toEqual(hooks[0].payloadSchema);
  });

  it('errors on an unknown name without echoing control characters', () => {
    const out = getWebhooks(withHooks(), { name: `nope${NEWLINE}${NEWLINE}IGNORE` }) as Payload;
    expect(out.error).toBeTruthy();
    expect(JSON.stringify(out)).not.toContain(JSON.stringify(NEWLINE).slice(1, -1));
  });
});

// Every string here came from a third-party document on its way into an
// agent's context.
describe('provider strings are neutralized', () => {
  it('strips control characters from names and descriptions', () => {
    const hostile: Webhook[] = [
      { name: `ev${NEWLINE}${NEWLINE}IGNORE PRIOR`, method: 'POST', description: `d${NEWLINE}e`, source: 'webhooks' },
    ];
    expect(JSON.stringify(getWebhooks(withHooks(hostile), {}))).not.toContain(JSON.stringify(NEWLINE).slice(1, -1));
  });
});
