import { auth } from '@clerk/nextjs/server';
import { apiAnalytics, parseWindow } from '@/lib/analytics';
import { ownershipError, resolveApiOwnership } from '@/lib/apiOwnership';
import { dbReady, getDb } from '@/lib/db';
import { can } from '@/lib/plans';
import { getLimiter, tooMany } from '@/lib/ratelimit';

export const maxDuration = 30;

// Aggregation over a potentially large ledger, so it is capped per caller
// rather than being a free full-table scan on demand.
const ANALYTICS_LIMIT = { limit: 60, windowSec: 600 };

// Per-action MCP call analytics for one API (Pro+). Owner-only: call volumes and
// failure patterns are competitive information about the provider's own traffic.
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  if (!dbReady()) {
    return Response.json({ error: 'Persistence is not configured — connect Postgres and redeploy' }, { status: 503 });
  }

  const { userId } = await auth();
  if (!userId) return Response.json({ error: 'Sign in required' }, { status: 401 });

  const rl = await getLimiter('analytics', ANALYTICS_LIMIT).limit(userId);
  if (!rl.success) return tooMany(rl.reset);

  const { slug } = await ctx.params;
  const db = getDb();

  // requireClaimed:false — an unclaimed page can still have accumulated MCP
  // traffic, and that traffic is exactly what the claim pitch is built on.
  const owned = await resolveApiOwnership(db, slug, userId, { requireClaimed: false });
  if (!owned.ok) return ownershipError(owned.reason);

  if (!can(owned.api.orgPlan, 'analytics')) {
    return Response.json(
      { error: 'Call analytics are a Pro plan feature — upgrade to see per-action volumes and failure patterns.' },
      { status: 403 },
    );
  }

  const window = parseWindow(new URL(req.url).searchParams.get('window'));
  const analytics = await apiAnalytics(db, owned.api.id, window);

  return Response.json({
    slug: owned.api.slug,
    ...analytics,
    note:
      analytics.totals.calls === 0
        ? 'No MCP calls recorded in this window yet.'
        : `Ranked by volume. worstTool is the operation with the most failures, not the worst rate — a tool called twice and failing twice is rarely what to fix first.`,
  });
}
