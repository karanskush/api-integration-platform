// The canary's per-field presence counts becoming an insight.

import { beforeAll, describe, expect, it } from 'vitest';
import { loadAdvisorInsights } from '../advisor/insights';
import * as schema from '../db/schema';
import { createTestDb, type TestDb } from '../db/__tests__/testDb';
import type { Action, ImportRecord } from '../ir';
import { buildPersistStatements } from '../persist';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
}, 30_000);

let seq = 0;
async function seedApi() {
  seq += 1;
  const [org] = await db.insert(schema.orgs).values({ name: `OS ${seq}`, slug: `os-${seq}` }).returning();
  const record: ImportRecord = {
    id: 'os',
    name: `Observed ${seq}`,
    source: 'openapi',
    baseUrls: ['https://api.example.com'],
    auth: 'none',
    actions: [
      { id: 'a1', name: 'list_pets', description: 'x', method: 'GET', path: '/pets', paramsSchema: { type: 'object', properties: {} }, auth: 'none', safety: 'read', examples: [] } as Action,
    ],
    counts: { total: 1, read: 1, write: 0, destructive: 0 },
    createdAt: 0,
    expiresAt: 0,
  };
  const built = await buildPersistStatements(db, { orgId: org.id, record, rawText: `{"os":${seq}}` });
  for (const st of built.statements) await st;
  return built;
}

const observation = (apiId: string, specVersionId: string, presentName: number, observedAt: Date, environment = 'production') => ({
  apiId,
  specVersionId,
  actionKey: 'a1',
  environment,
  sampleCount: 3,
  statusCounts: { '200': 3 },
  shape: {
    'response.data[].id': { types: ['string'], presentIn: 3 },
    'response.data[].name': { types: ['string'], presentIn: presentName },
  },
  observedAt,
});

describe('loading observed shapes', () => {
  it('surfaces per-field presence for the operation', async () => {
    const { apiId, specVersionId, slug } = await seedApi();
    await db.insert(schema.operationObservations).values(observation(apiId, specVersionId, 1, new Date('2026-09-09T10:00:00Z')));

    const [shape] = (await loadAdvisorInsights(slug, db)).observedShapes;
    expect(shape.actionId).toBe('a1');
    expect(shape.sampleCount).toBe(3);
    expect(shape.fields).toEqual(
      expect.arrayContaining([
        { path: 'response.data[].id', presentIn: 3, types: ['string'] },
        { path: 'response.data[].name', presentIn: 1, types: ['string'] },
      ]),
    );
  });

  it('keeps only the newest observation per operation', async () => {
    const { apiId, specVersionId, slug } = await seedApi();
    await db.insert(schema.operationObservations).values([
      observation(apiId, specVersionId, 1, new Date('2026-09-01T10:00:00Z')),
      observation(apiId, specVersionId, 3, new Date('2026-09-09T10:00:00Z')),
    ]);

    const shapes = (await loadAdvisorInsights(slug, db)).observedShapes;
    expect(shapes).toHaveLength(1);
    expect(shapes[0].fields.find((f) => f.path === 'response.data[].name')?.presentIn).toBe(3);
  });

  // A sandbox shape is a different API for this purpose.
  it('ignores a sandbox observation', async () => {
    const { apiId, specVersionId, slug } = await seedApi();
    await db.insert(schema.operationObservations).values(observation(apiId, specVersionId, 0, new Date('2026-09-09T10:00:00Z'), 'sandbox'));
    expect((await loadAdvisorInsights(slug, db)).observedShapes).toEqual([]);
  });
});
