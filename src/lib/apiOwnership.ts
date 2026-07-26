// Shared "does this signed-in user control this API page" check.
//
// Four routes need the identical sequence — resolve the slug, confirm org
// membership, require the page to be claimed — and an authorization check
// duplicated four ways is an authorization check that will eventually disagree
// with itself. Membership is proven by joining users -> org_members -> the API's
// org, so a user who was removed from an org loses access immediately rather
// than on their next token refresh.

import { and, eq } from 'drizzle-orm';
import type { Db } from './db';
import { apis, orgMembers, orgs, users } from './db/schema';

export type OwnedApi = {
  id: string;
  slug: string;
  orgId: string;
  orgPlan: string;
  claimStatus: string;
  visibility: string;
  ciTokenVersion: number;
  mcpTokenVersion: number;
  userId: string;
  role: string;
};

export type OwnershipFailure = 'unknown_api' | 'forbidden' | 'unclaimed';

export type OwnershipResult = { ok: true; api: OwnedApi } | { ok: false; reason: OwnershipFailure };

export async function resolveApiOwnership(
  db: Db,
  slug: string,
  clerkUserId: string,
  opts: { requireClaimed?: boolean } = {},
): Promise<OwnershipResult> {
  const [api] = await db
    .select({
      id: apis.id,
      slug: apis.slug,
      orgId: apis.orgId,
      orgPlan: orgs.plan,
      claimStatus: apis.claimStatus,
      visibility: apis.visibility,
      ciTokenVersion: apis.ciTokenVersion,
      mcpTokenVersion: orgs.mcpTokenVersion,
    })
    .from(apis)
    .innerJoin(orgs, eq(orgs.id, apis.orgId))
    .where(eq(apis.slug, slug))
    .limit(1);
  if (!api) return { ok: false, reason: 'unknown_api' };

  const [membership] = await db
    .select({ userId: users.id, role: orgMembers.role })
    .from(users)
    .innerJoin(orgMembers, eq(orgMembers.userId, users.id))
    .where(and(eq(users.clerkUserId, clerkUserId), eq(orgMembers.orgId, api.orgId)))
    .limit(1);
  if (!membership) return { ok: false, reason: 'forbidden' };

  if (opts.requireClaimed !== false && api.claimStatus !== 'claimed') {
    return { ok: false, reason: 'unclaimed' };
  }

  return { ok: true, api: { ...api, userId: membership.userId, role: membership.role } };
}

const MESSAGES: Record<OwnershipFailure, { status: number; error: string }> = {
  // 404 rather than 403 for an unknown slug: a signed-in user should not be
  // able to probe which pages exist by watching the status code change.
  unknown_api: { status: 404, error: 'Unknown API' },
  forbidden: { status: 403, error: 'Forbidden' },
  unclaimed: { status: 409, error: 'This API has not been claimed yet.' },
};

export function ownershipError(reason: OwnershipFailure, override?: string): Response {
  const { status, error } = MESSAGES[reason];
  return Response.json({ error: override ?? error }, { status });
}
