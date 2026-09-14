// The events an API emits, read out of the spec and carried through storage.
//
// Neither OpenAPI 3.1 `webhooks` nor 3.0 `callbacks` was parsed before, so
// the one part of a contract describing traffic in the OTHER direction reached
// nobody. These pin both spellings, the secret filter on a payload example,
// the cap, and the round trip through Postgres.

import { beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { createTestDb, type TestDb } from '../db/__tests__/testDb';
import type { ImportRecord } from '../ir';
import { normalizeOpenApi } from '../normalize';
import { buildPersistStatements } from '../persist';
import { loadPersistentRecord } from '../persistentApi';

const k = (...parts: string[]) => parts.join('');
const STRIPE_KEY = k('sk', '_live_', '51H8xYzAbCdEfGhIjKlMnOpQr');

const base = (extra: Record<string, unknown>) => ({
  openapi: '3.1.0',
  info: { title: 'Events', version: '1' },
  servers: [{ url: 'https://api.example.com' }],
  paths: {
    '/subscriptions': {
      post: {
        operationId: 'createSubscription',
        requestBody: {
          content: { 'application/json': { schema: { type: 'object', properties: { callbackUrl: { type: 'string' } } } } },
        },
        responses: { '201': { description: 'Created' } },
        ...(extra.callbacks ? { callbacks: extra.callbacks } : {}),
      },
    },
  },
  ...(extra.webhooks ? { webhooks: extra.webhooks } : {}),
});

const payload = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string' },
    amount: { type: 'integer' },
    signingSecret: { type: 'string', example: STRIPE_KEY },
  },
};

describe('OpenAPI 3.1 webhooks', () => {
  const doc = base({
    webhooks: {
      'order.created': {
        post: { summary: 'An order was placed', requestBody: { content: { 'application/json': { schema: payload } } } },
      },
      'order.refunded': { post: { description: 'Refund settled.' } },
    },
  });

  it('reads name, method and description', () => {
    const { webhooks } = normalizeOpenApi(doc);
    expect(webhooks.map((w) => [w.name, w.method, w.description, w.source])).toEqual([
      ['order.created', 'POST', 'An order was placed', 'webhooks'],
      ['order.refunded', 'POST', 'Refund settled.', 'webhooks'],
    ]);
  });

  it('keeps the payload schema and withholds a credential-looking example', () => {
    const { webhooks, redactions } = normalizeOpenApi(doc);
    const props = webhooks[0].payloadSchema?.properties as Record<string, Record<string, unknown>>;

    expect(Object.keys(props)).toEqual(['id', 'amount', 'signingSecret']);
    expect(JSON.stringify(webhooks)).not.toContain(STRIPE_KEY);
    expect(redactions.some((r) => r.at.includes('order.created'))).toBe(true);
  });
});

describe('OpenAPI 3.0 callbacks', () => {
  it('reads a callback and names the operation that registers it', () => {
    const spec = normalizeOpenApi(
      base({
        callbacks: {
          onEvent: {
            '{$request.body#/callbackUrl}': {
              post: { summary: 'Event delivered', requestBody: { content: { 'application/json': { schema: payload } } } },
            },
          },
        },
      }),
    );
    expect(spec.webhooks).toHaveLength(1);
    expect(spec.webhooks[0]).toMatchObject({
      name: 'onEvent',
      method: 'POST',
      source: 'callback',
      callbackOf: spec.actions[0].name,
    });
  });
});

describe('bounds and absence', () => {
  it('declares none when the spec declares none', () => {
    expect(normalizeOpenApi(base({})).webhooks).toEqual([]);
  });

  it('caps the count', () => {
    const webhooks = Object.fromEntries(
      Array.from({ length: 80 }, (_, i) => [`ev${i}`, { post: { summary: `e${i}` } }]),
    );
    expect(normalizeOpenApi(base({ webhooks })).webhooks.length).toBeLessThanOrEqual(50);
  });
});

describe('the round trip through Postgres', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  }, 30_000);

  const record = (id: string, name: string, webhooks?: ImportRecord['webhooks']): ImportRecord => ({
    id,
    name,
    source: 'openapi',
    baseUrls: ['https://api.example.com'],
    auth: 'none',
    actions: [],
    counts: { total: 0, read: 0, write: 0, destructive: 0 },
    createdAt: 0,
    expiresAt: 0,
    ...(webhooks ? { webhooks } : {}),
  });

  it('stores webhooks on the spec version and reads them back on the record', async () => {
    const [org] = await db.insert(schema.orgs).values({ name: 'WH Org', slug: 'wh-org' }).returning();
    const hooks: ImportRecord['webhooks'] = [
      { name: 'order.created', method: 'POST', description: 'An order was placed', source: 'webhooks', payloadSchema: { type: 'object' } },
    ];
    const built = await buildPersistStatements(db, { orgId: org.id, record: record('wh', 'Webhooked', hooks), rawText: '{"wh":1}' });
    for (const st of built.statements) await st;

    expect((await loadPersistentRecord(built.slug, db))?.webhooks).toEqual(hooks);
  });

  it('leaves the field absent, not empty, when none were declared', async () => {
    const [org] = await db.insert(schema.orgs).values({ name: 'WH Org 2', slug: 'wh-org-2' }).returning();
    const built = await buildPersistStatements(db, { orgId: org.id, record: record('wh2', 'Silent'), rawText: '{"wh":2}' });
    for (const st of built.statements) await st;

    expect((await loadPersistentRecord(built.slug, db))?.webhooks).toBeUndefined();
  });
});
