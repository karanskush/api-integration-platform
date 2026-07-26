import { beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { createTestDb, type TestDb } from '../db/__tests__/testDb';
import { getOrgPlanForSlug } from '../credits';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
}, 30_000);

describe('getOrgPlanForSlug', () => {
  it('resolves the api, org, plan, visibility, and MCP token version by slug', async () => {
    const [org] = await db.insert(schema.orgs).values({ name: 'Credits Org', slug: 'credits-org', plan: 'pro' }).returning();
    const [api] = await db.insert(schema.apis).values({ orgId: org.id, slug: 'credits-api', name: 'Credits API' }).returning();

    const result = await getOrgPlanForSlug(db, 'credits-api');
    expect(result).toEqual({
      apiId: api.id,
      orgId: org.id,
      plan: 'pro',
      visibility: 'public',
      mcpTokenVersion: 0,
    });
  });

  // The MCP route verifies an access token against this in the same query that
  // resolves the plan, so a rotation has to be visible here.
  it('reflects a bumped MCP token version', async () => {
    const [org] = await db
      .insert(schema.orgs)
      .values({ name: 'Rotated Org', slug: 'credits-org-rotated', plan: 'team', mcpTokenVersion: 4 })
      .returning();
    await db.insert(schema.apis).values({ orgId: org.id, slug: 'credits-api-rotated', name: 'Rotated API' });

    expect(await getOrgPlanForSlug(db, 'credits-api-rotated')).toMatchObject({ plan: 'team', mcpTokenVersion: 4 });
  });

  it('returns null for an unknown slug', async () => {
    expect(await getOrgPlanForSlug(db, 'no-such-slug')).toBeNull();
  });
});
