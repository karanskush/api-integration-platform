// Private-API visibility enforcement (Team+).
//
// apis.visibility has existed since Phase 1 and was checked nowhere: a page set
// to 'private' was still fully public on the page, the badge, the playground
// proxy, and the MCP server. This is the enforcement layer.
//
// The rule is that a private API must be indistinguishable from a nonexistent
// one to an unauthorized caller — 404, never 403. A 403 confirms the slug
// exists, which for a private API is itself the leak: "acme-internal-billing"
// existing is information.

import { and, eq } from 'drizzle-orm';
import { dbReady, getDb } from './db';
import { apis, orgMembers, orgs, users } from './db/schema';

export function isPrivate(visibility: string | null | undefined): boolean {
  return visibility === 'private';
}

export type VisibilityCheck = {
  exists: boolean;
  private: boolean;
  orgId: string | null;
  apiId: string | null;
  plan: string | null;
  mcpTokenVersion: number;
};

export async function apiVisibility(slug: string): Promise<VisibilityCheck> {
  const absent: VisibilityCheck = { exists: false, private: false, orgId: null, apiId: null, plan: null, mcpTokenVersion: 0 };
  if (!dbReady()) return absent;

  const [row] = await getDb()
    .select({
      apiId: apis.id,
      orgId: apis.orgId,
      visibility: apis.visibility,
      plan: orgs.plan,
      mcpTokenVersion: orgs.mcpTokenVersion,
    })
    .from(apis)
    .innerJoin(orgs, eq(orgs.id, apis.orgId))
    .where(eq(apis.slug, slug))
    .limit(1);
  if (!row) return absent;

  return {
    exists: true,
    private: isPrivate(row.visibility),
    orgId: row.orgId,
    apiId: row.apiId,
    plan: row.plan,
    mcpTokenVersion: row.mcpTokenVersion,
  };
}

// Membership by Clerk user id, for the server components and routes that have a
// session rather than a token.
export async function isOrgMember(clerkUserId: string | null | undefined, orgId: string): Promise<boolean> {
  if (!clerkUserId || !dbReady()) return false;
  const [row] = await getDb()
    .select({ userId: users.id })
    .from(users)
    .innerJoin(orgMembers, eq(orgMembers.userId, users.id))
    .where(and(eq(users.clerkUserId, clerkUserId), eq(orgMembers.orgId, orgId)))
    .limit(1);
  return Boolean(row);
}

// True when a private API may be shown to this caller. Public APIs always pass,
// so callers can apply this unconditionally.
export async function canViewApi(slug: string, clerkUserId: string | null | undefined): Promise<boolean> {
  const visibility = await apiVisibility(slug);
  if (!visibility.exists) return false;
  if (!visibility.private) return true;
  return visibility.orgId ? isOrgMember(clerkUserId, visibility.orgId) : false;
}
