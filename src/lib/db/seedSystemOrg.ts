import { eq } from 'drizzle-orm';
import type { Db } from '../db';
import { orgs } from './schema';

export const SYSTEM_ORG_SLUG = 'spotcheck-unofficial';

// Idempotent: the sentinel org that owns unclaimed/seeded API pages, since
// apis.orgId is NOT NULL and cannot be made nullable without touching every
// existing query. Mirrors getOrCreateOrgForUser's insert-then-select idiom.
export async function getOrCreateSystemOrg(db: Db): Promise<typeof orgs.$inferSelect> {
  const [org] = await db
    .insert(orgs)
    .values({ name: 'Spotcheck (unofficial pages)', slug: SYSTEM_ORG_SLUG, plan: 'free', isSystem: true })
    .onConflictDoNothing({ target: orgs.slug })
    .returning();
  if (org) return org;

  const [existing] = await db.select().from(orgs).where(eq(orgs.slug, SYSTEM_ORG_SLUG)).limit(1);
  return existing;
}
