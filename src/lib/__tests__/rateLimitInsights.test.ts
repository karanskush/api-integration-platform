// probe.rate_limit facts becoming an insight: newest policy per operation.

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
  const [org] = await db.insert(schema.orgs).values({ name: `RL ${seq}`, slug: `rl-${seq}` }).returning();
  const record: ImportRecord = {
    id: 'rl',
    name: `Rate Limited ${seq}`,
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
  const built = await buildPersistStatements(db, { orgId: org.id, record, rawText: `{"rl":${seq}}` });
  for (const st of built.statements) await st;
  return built;
}

const fact = (apiId: string, limit: number, observedAt: Date, name = 'default') => ({
  apiId,
  kind: 'probe.rate_limit',
  source: 'probe',
  environment: 'production',
  observedAt,
  payload: { actionId: 'a1', tool: 'list_pets', method: 'GET', path: '/pets', name, limit, windowSeconds: 60, header: 'ratelimit-policy', raw: `"${name}";q=${limit};w=60` },
});

describe('loading rate-limit insights', () => {
  it('surfaces the policy for the operation', async () => {
    const { apiId, slug } = await seedApi();
    await db.insert(schema.evidenceFacts).values(fact(apiId, 100, new Date('2026-09-09T10:00:00Z')));

    const insights = await loadAdvisorInsights(slug, db);
    expect(insights.rateLimits).toEqual([
      { actionId: 'a1', name: 'default', limit: 100, windowSeconds: 60, header: 'ratelimit-policy', observedAt: '2026-09-09T10:00:00.000Z' },
    ]);
  });

  // A quota raised last week must not also report the old one.
  it('keeps only the newest policy per operation', async () => {
    const { apiId, slug } = await seedApi();
    await db.insert(schema.evidenceFacts).values([
      fact(apiId, 100, new Date('2026-09-01T10:00:00Z')),
      fact(apiId, 500, new Date('2026-09-09T10:00:00Z')),
    ]);

    const insights = await loadAdvisorInsights(slug, db);
    expect(insights.rateLimits).toHaveLength(1);
    expect(insights.rateLimits[0].limit).toBe(500);
  });

  it('keeps distinct named policies apart', async () => {
    const { apiId, slug } = await seedApi();
    await db.insert(schema.evidenceFacts).values([
      fact(apiId, 10, new Date('2026-09-09T10:00:00Z'), 'burst'),
      fact(apiId, 1000, new Date('2026-09-09T10:00:00Z'), 'daily'),
    ]);

    const insights = await loadAdvisorInsights(slug, db);
    expect(insights.rateLimits.map((r) => r.name).sort()).toEqual(['burst', 'daily']);
  });
});
