import { eq } from 'drizzle-orm';
import type { Db } from './db';
import { orgMembers, orgs, users } from './db/schema';
import { uniqueSlug } from './slugify';

export type OrgContext = {
  user: typeof users.$inferSelect;
  org: typeof orgs.$inferSelect;
};

async function createPersonalOrg(db: Db, userId: string, email: string) {
  const base = email.split('@')[0] || 'org';
  const slug = await uniqueSlug(base, async (candidate) => {
    const rows = await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.slug, candidate)).limit(1);
    return rows.length > 0;
  });
  const [org] = await db.insert(orgs).values({ name: base, slug, plan: 'free' }).returning();
  await db.insert(orgMembers).values({ orgId: org.id, userId, role: 'owner' });
  return org;
}

// Idempotent lazy 1:1 org creation on first authed request. Phase 1 doesn't
// use Clerk Organizations — real multi-seat orgs are a Phase 3 concern, once
// Team's 5-seat feature actually ships. This is a lightweight personal org
// per user, matching the org_members table's shape without extra Clerk
// webhook plumbing.
//
// Takes `db` as a parameter (rather than calling getDb() itself) so it stays
// testable against the pglite harness without a real DATABASE_URL — route
// handlers are the only place that should call getDb().
//
// Known limitation: a genuinely brand-new user's very first two concurrent
// requests could each pass the "no membership yet" check and create two
// personal orgs. Rare enough, and cheap enough to reconcile manually later,
// that it isn't worth a stricter lock for Phase 1.
export async function getOrCreateOrgForUser(db: Db, clerkUserId: string, email: string): Promise<OrgContext> {
  let [user] = await db
    .insert(users)
    .values({ clerkUserId, email })
    .onConflictDoNothing({ target: users.clerkUserId })
    .returning();
  if (!user) {
    [user] = await db.select().from(users).where(eq(users.clerkUserId, clerkUserId)).limit(1);
  }

  const membership = await db
    .select({ org: orgs })
    .from(orgMembers)
    .innerJoin(orgs, eq(orgMembers.orgId, orgs.id))
    .where(eq(orgMembers.userId, user.id))
    .limit(1);
  if (membership.length) return { user, org: membership[0].org };

  const org = await createPersonalOrg(db, user.id, email);
  return { user, org };
}
