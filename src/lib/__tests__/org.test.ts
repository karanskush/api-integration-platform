import { beforeAll, describe, expect, it } from 'vitest';
import { getOrCreateOrgForUser } from '../org';
import { createTestDb, type TestDb } from '../db/__tests__/testDb';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
}, 30_000);

describe('getOrCreateOrgForUser', () => {
  it('creates a user and a personal org on first call', async () => {
    const { user, org } = await getOrCreateOrgForUser(db, 'clerk_1', 'kasi@example.com');
    expect(user.clerkUserId).toBe('clerk_1');
    expect(org.slug).toBe('kasi');
    expect(org.plan).toBe('free');
  });

  it('is idempotent: a second call for the same user returns the same org', async () => {
    const first = await getOrCreateOrgForUser(db, 'clerk_2', 'sam@example.com');
    const second = await getOrCreateOrgForUser(db, 'clerk_2', 'sam@example.com');
    expect(second.user.id).toBe(first.user.id);
    expect(second.org.id).toBe(first.org.id);
  });

  it('gives two different users with the same email local-part distinct, collision-suffixed org slugs', async () => {
    const a = await getOrCreateOrgForUser(db, 'clerk_3', 'dup@example.com');
    const b = await getOrCreateOrgForUser(db, 'clerk_4', 'dup@other.com');
    expect(a.org.slug).not.toBe(b.org.slug);
    expect(b.org.slug).toBe(`${a.org.slug}-2`);
  });
});
