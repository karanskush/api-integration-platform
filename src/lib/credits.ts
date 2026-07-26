import { eq } from 'drizzle-orm';
import type { Db } from './db';
import { apis, orgs } from './db/schema';
import { getLimiter, type Limiter } from './ratelimit';

export type OrgPlanInfo = {
  apiId: string;
  orgId: string;
  plan: string;
  visibility: string;
  // Needed by the MCP route to verify an access token in the same query that
  // resolves the plan, rather than a second round trip per request.
  mcpTokenVersion: number;
};

// Only persistent (org-backed) APIs have credit metering — ephemeral
// /mcp/[id] keeps the flat per-IP rate limit unchanged, since there's no
// org/plan to meter against.
export async function getOrgPlanForSlug(db: Db, slug: string): Promise<OrgPlanInfo | null> {
  const [row] = await db
    .select({
      apiId: apis.id,
      orgId: apis.orgId,
      plan: orgs.plan,
      visibility: apis.visibility,
      mcpTokenVersion: orgs.mcpTokenVersion,
    })
    .from(apis)
    .innerJoin(orgs, eq(apis.orgId, orgs.id))
    .where(eq(apis.slug, slug))
    .limit(1);
  return row ?? null;
}

// Reuses ratelimit.ts's getLimiter() unchanged — just a plan-derived daily
// ceiling instead of the fixed IP-scoped abuse guard already applied
// independently on every /mcp/[id] request. The org id is the *key* passed to
// .limit(), not part of the scope: a per-org scope would add one cached
// limiter per org forever (see ratelimit.ts).
export function creditLimiter(dailyCeiling: number): Limiter {
  return getLimiter('mcp-credits', { limit: dailyCeiling, windowSec: 86_400 });
}
