// The read-only half of the state-machine map: which states an entity was
// actually seen in, with no transition claimed.
//
// These values come out of RESPONSES, which is the direction this codebase
// otherwise refuses to store from. The cardinality guard is the entire safety
// argument, so most of this file exercises it directly rather than through a
// probe run.

import { describe, expect, it } from 'vitest';
import { runStateVocabulary, vocabularyFor } from '../stateVocabulary';
import type { Action, ImportRecord } from '../../ir';
import type { invokeAction } from '../../mcpTools';

const rec = (n: number, build: (i: number) => Record<string, unknown>) =>
  Array.from({ length: n }, (_, i) => build(i));

describe('the cardinality guard', () => {
  it('keeps a field whose few values repeat across many records', () => {
    const records = rec(12, (i) => ({ status: ['active', 'canceled', 'past_due'][i % 3] }));
    const result = vocabularyFor(records, 'status');

    expect(result?.values).toEqual(['active', 'canceled', 'past_due']);
    expect(result?.sampleCount).toBe(12);
  });

  // THE guard. A field with roughly one value per record is data — a name, an
  // email, an id — not a vocabulary, and must not be retained.
  it('drops a field with a distinct value per record', () => {
    const records = rec(10, (i) => ({ status: `unique-value-${i}` }));
    expect(vocabularyFor(records, 'status')).toBeNull();
  });

  it('drops a field at exactly half distinct, which is not repetition enough', () => {
    const records = rec(8, (i) => ({ status: `s${Math.floor(i / 2)}` })); // 4 distinct of 8
    expect(vocabularyFor(records, 'status')).toBeNull();
  });

  it('needs enough records to tell the difference at all', () => {
    const records = rec(3, () => ({ status: 'active' }));
    expect(vocabularyFor(records, 'status')).toBeNull();
  });

  it('drops a field carrying prose rather than a token', () => {
    const records = rec(10, (i) => ({ status: i % 2 ? 'Payment failed: card declined (see docs).' : 'ok' }));
    expect(vocabularyFor(records, 'status')).toBeNull();
  });

  it('drops an email or identifier shape outright', () => {
    expect(vocabularyFor(rec(10, () => ({ status: 'a@example.com' })), 'status')).toBeNull();
    expect(vocabularyFor(rec(10, () => ({ status: 'cus_A1b2C3' })), 'status')).toBeNull();
  });

  it('drops an over-long value', () => {
    expect(vocabularyFor(rec(10, () => ({ status: 'x'.repeat(40) })), 'status')).toBeNull();
  });

  it('drops a taxonomy too large to be a state machine', () => {
    const records = rec(60, (i) => ({ status: `state${i % 20}` }));
    expect(vocabularyFor(records, 'status')).toBeNull();
  });

  it('ignores records where the field is absent or not a string', () => {
    const records = [
      ...rec(8, (i) => ({ status: i % 2 ? 'active' : 'canceled' })),
      { other: 'x' },
      { status: 42 },
    ];
    expect(vocabularyFor(records, 'status')?.sampleCount).toBe(8);
  });
});

function action(overrides: Partial<Action> & { name: string; path: string }): Action {
  return {
    id: `id_${overrides.name}`,
    description: 'x',
    method: 'GET',
    paramsSchema: { type: 'object', properties: {} },
    auth: 'bearer',
    safety: 'read',
    examples: [],
    ...overrides,
  } as Action;
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

const listSubs = () => action({ name: 'list_subscriptions', path: '/v1/subscriptions' });

function api(body: unknown, status = 200) {
  const calls: string[] = [];
  const invoke = (async (a: Action) => {
    calls.push(a.name);
    return { status, latencyMs: 5, bodyText: JSON.stringify(body) };
  }) as unknown as typeof invokeAction;
  return { invoke, calls };
}

const payloads = (e: Awaited<ReturnType<typeof runStateVocabulary>>) =>
  e.map((x) => x.payload as { field: string; values: string[]; sampleCount: number });

describe('sampling a list endpoint', () => {
  const SUBS = rec(12, (i) => ({ id: i, status: ['active', 'canceled', 'trialing'][i % 3] }));

  it('reads a bare array response', async () => {
    const { invoke } = api(SUBS);
    const result = await runStateVocabulary({ record: record([listSubs()]), invoke });

    expect(payloads(result)[0].values).toEqual(['active', 'canceled', 'trialing']);
  });

  it('reads the usual list envelopes', async () => {
    for (const key of ['data', 'items', 'results', 'records']) {
      const { invoke } = api({ [key]: SUBS });
      const result = await runStateVocabulary({ record: record([listSubs()]), invoke });
      expect(payloads(result)[0]?.values).toEqual(['active', 'canceled', 'trialing']);
    }
  });

  it('does not sample a single-record endpoint', async () => {
    const { invoke, calls } = api(SUBS);
    const detail = action({
      name: 'get_subscription',
      path: '/v1/subscriptions/{id}',
      paramsSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string', 'x-docentapi-in': 'path' } } },
    });
    await runStateVocabulary({ record: record([detail]), invoke });
    expect(calls).toHaveLength(0);
  });

  // An error body has its own `status` field, and recording it as the entity's
  // state vocabulary would be a genuinely misleading claim.
  it('ignores a non-2xx response', async () => {
    const { invoke } = api({ status: 'error', message: 'nope' }, 500);
    expect(await runStateVocabulary({ record: record([listSubs()]), invoke })).toHaveLength(0);
  });

  it('ignores an unparseable body', async () => {
    const invoke = (async () => ({ status: 200, latencyMs: 5, bodyText: 'not json' })) as unknown as typeof invokeAction;
    expect(await runStateVocabulary({ record: record([listSubs()]), invoke })).toHaveLength(0);
  });

  it('only looks at fields that name a state', async () => {
    const withNames = rec(12, (i) => ({ status: i % 2 ? 'active' : 'canceled', customerName: `Person ${i}` }));
    const { invoke } = api(withNames);
    const result = await runStateVocabulary({ record: record([listSubs()]), invoke });

    expect(payloads(result).map((p) => p.field)).toEqual(['status']);
    expect(JSON.stringify(result)).not.toContain('Person');
  });

  it('claims no transitions', async () => {
    const { invoke } = api(SUBS);
    const result = await runStateVocabulary({ record: record([listSubs()]), invoke });
    expect(JSON.stringify(result)).not.toMatch(/transition|from|to\b/i);
  });
});
