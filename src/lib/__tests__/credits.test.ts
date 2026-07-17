import { beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { createTestDb, type TestDb } from '../db/__tests__/testDb';
import { getOrgPlanForSlug } from '../credits';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
}, 30_000);

describe('getOrgPlanForSlug', () => {
  it('resolves apiId/orgId/plan by slug', async () => {
    const [org] = await db.insert(schema.orgs).values({ name: 'Credits Org', slug: 'credits-org', plan: 'pro' }).returning();
    const [api] = await db.insert(schema.apis).values({ orgId: org.id, slug: 'credits-api', name: 'Credits API' }).returning();

    const result = await getOrgPlanForSlug(db, 'credits-api');
    expect(result).toEqual({ apiId: api.id, orgId: org.id, plan: 'pro' });
  });

  it('returns null for an unknown slug', async () => {
    expect(await getOrgPlanForSlug(db, 'no-such-slug')).toBeNull();
  });
});
