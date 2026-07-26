// visibility.ts reads through the module-level getDb(), so these tests point
// DATABASE_URL at nothing for the degraded-path cases and stub the module's db
// accessor for the rest — the same seam persistentApi's callers rely on.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../db/schema';
import { createTestDb, type TestDb } from '../db/__tests__/testDb';
import { isPrivate } from '../visibility';

let db: TestDb;

const originalUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  db = await createTestDb();
}, 30_000);

// dbReady() only checks that DATABASE_URL is set; getDb() is what actually
// connects, and that is what the mock below replaces.
beforeEach(() => {
  process.env.DATABASE_URL = 'postgres://stub/stub';
});

afterEach(() => {
  vi.resetModules();
  if (originalUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalUrl;
});

async function loadVisibility() {
  vi.resetModules();
  vi.doMock('../db', () => ({
    dbReady: () => Boolean(process.env.DATABASE_URL),
    getDb: () => db,
  }));
  return import('../visibility');
}

let seq = 0;
async function seed(opts: { visibility?: string; plan?: string } = {}) {
  seq += 1;
  const [org] = await db
    .insert(schema.orgs)
    .values({ name: `Vis Org ${seq}`, slug: `vis-org-${seq}`, plan: opts.plan ?? 'team' })
    .returning();
  const [api] = await db
    .insert(schema.apis)
    .values({
      orgId: org.id,
      slug: `vis-api-${seq}`,
      name: `Vis API ${seq}`,
      visibility: opts.visibility ?? 'public',
    })
    .returning();
  return { orgId: org.id, apiId: api.id, slug: api.slug };
}

async function addMember(orgId: string, clerkUserId: string) {
  const [user] = await db
    .insert(schema.users)
    .values({ clerkUserId, email: `${clerkUserId}@example.com` })
    .returning();
  await db.insert(schema.orgMembers).values({ orgId, userId: user.id });
  return user;
}

describe('isPrivate', () => {
  it('only treats the exact "private" value as private', () => {
    expect(isPrivate('private')).toBe(true);
    expect(isPrivate('public')).toBe(false);
    expect(isPrivate(null)).toBe(false);
    expect(isPrivate(undefined)).toBe(false);
    // Fail safe: an unrecognised value is not silently treated as private, so a
    // typo cannot hide a page — but it is also not treated AS private, so the
    // column stays the single source of truth.
    expect(isPrivate('Private')).toBe(false);
  });
});

describe('apiVisibility', () => {
  it('reports a public API as existing and not private', async () => {
    const { apiVisibility } = await loadVisibility();
    const seeded = await seed();
    expect(await apiVisibility(seeded.slug)).toMatchObject({ exists: true, private: false, orgId: seeded.orgId });
  });

  it('reports a private API as private, with its org and plan', async () => {
    const { apiVisibility } = await loadVisibility();
    const seeded = await seed({ visibility: 'private', plan: 'business' });
    expect(await apiVisibility(seeded.slug)).toMatchObject({
      exists: true,
      private: true,
      orgId: seeded.orgId,
      plan: 'business',
    });
  });

  it('reports a missing slug as not existing', async () => {
    const { apiVisibility } = await loadVisibility();
    expect(await apiVisibility('no-such-api')).toMatchObject({ exists: false, orgId: null });
  });

  it('degrades to not-existing when there is no database configured', async () => {
    delete process.env.DATABASE_URL;
    const { apiVisibility } = await loadVisibility();
    expect(await apiVisibility('anything')).toMatchObject({ exists: false });
  });

  it('surfaces the org MCP token version for the private-MCP gate', async () => {
    const { apiVisibility } = await loadVisibility();
    seq += 1;
    const [org] = await db
      .insert(schema.orgs)
      .values({ name: 'Vis Token Org', slug: `vis-token-org-${seq}`, plan: 'team', mcpTokenVersion: 7 })
      .returning();
    const [api] = await db
      .insert(schema.apis)
      .values({ orgId: org.id, slug: `vis-token-api-${seq}`, name: 'Token API', visibility: 'private' })
      .returning();

    expect(await apiVisibility(api.slug)).toMatchObject({ private: true, mcpTokenVersion: 7 });
  });
});

describe('isOrgMember', () => {
  it('is true for a member and false for a stranger', async () => {
    const { isOrgMember } = await loadVisibility();
    const seeded = await seed();
    await addMember(seeded.orgId, `clerk_member_${seq}`);

    expect(await isOrgMember(`clerk_member_${seq}`, seeded.orgId)).toBe(true);
    expect(await isOrgMember('clerk_stranger', seeded.orgId)).toBe(false);
  });

  it('is false for an absent user id', async () => {
    const { isOrgMember } = await loadVisibility();
    const seeded = await seed();
    expect(await isOrgMember(null, seeded.orgId)).toBe(false);
    expect(await isOrgMember(undefined, seeded.orgId)).toBe(false);
  });

  it('does not treat membership of one org as membership of another', async () => {
    const { isOrgMember } = await loadVisibility();
    const mine = await seed();
    const theirs = await seed();
    await addMember(mine.orgId, `clerk_scoped_${seq}`);
    expect(await isOrgMember(`clerk_scoped_${seq}`, theirs.orgId)).toBe(false);
  });
});

describe('canViewApi', () => {
  it('lets anyone, signed in or not, view a public API', async () => {
    const { canViewApi } = await loadVisibility();
    const seeded = await seed();
    expect(await canViewApi(seeded.slug, null)).toBe(true);
    expect(await canViewApi(seeded.slug, 'clerk_anyone')).toBe(true);
  });

  // The property the whole feature rests on.
  it('hides a private API from an anonymous visitor', async () => {
    const { canViewApi } = await loadVisibility();
    const seeded = await seed({ visibility: 'private' });
    expect(await canViewApi(seeded.slug, null)).toBe(false);
  });

  it('hides a private API from a signed-in non-member', async () => {
    const { canViewApi } = await loadVisibility();
    const seeded = await seed({ visibility: 'private' });
    await addMember(seeded.orgId, `clerk_owner_${seq}`);
    expect(await canViewApi(seeded.slug, 'clerk_outsider')).toBe(false);
  });

  it('shows a private API to a member of its org', async () => {
    const { canViewApi } = await loadVisibility();
    const seeded = await seed({ visibility: 'private' });
    await addMember(seeded.orgId, `clerk_insider_${seq}`);
    expect(await canViewApi(seeded.slug, `clerk_insider_${seq}`)).toBe(true);
  });

  it('returns false for a slug that does not exist, matching the 404 path', async () => {
    const { canViewApi } = await loadVisibility();
    expect(await canViewApi('no-such-api', 'clerk_anyone')).toBe(false);
  });
});
