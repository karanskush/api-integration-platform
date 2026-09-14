import { auth } from '@clerk/nextjs/server';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { dbReady, getDb } from '@/lib/db';
import { apis, credentials, orgMembers, probeResources, probeRuns, users } from '@/lib/db/schema';
import { releaseBlocked } from '@/lib/probes/policy';

// What the write runner has done for this API: recent runs with their §12.11
// terminal state, how many fixtures are still unresolved or quarantined, and
// whether that blocks a release. Counts and closed-vocabulary states only —
// the ledger's sealed identifiers never leave the database through here.
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  if (!dbReady()) return Response.json({ error: 'Persistence is not configured' }, { status: 503 });
  const { userId } = await auth();
  if (!userId) return Response.json({ error: 'Sign in required' }, { status: 401 });

  const { slug } = await ctx.params;
  const db = getDb();
  const [api] = await db.select({ id: apis.id, orgId: apis.orgId }).from(apis).where(eq(apis.slug, slug)).limit(1);
  if (!api) return Response.json({ error: 'Unknown API' }, { status: 404 });

  const membership = await db
    .select({ userId: users.id })
    .from(users)
    .innerJoin(orgMembers, eq(orgMembers.userId, users.id))
    .where(and(eq(users.clerkUserId, userId), eq(orgMembers.orgId, api.orgId)))
    .limit(1);
  if (!membership.length) return Response.json({ error: 'Forbidden' }, { status: 403 });

  const [runs, counts, [cred]] = await Promise.all([
    db
      .select({
        id: probeRuns.id,
        status: probeRuns.status,
        environment: probeRuns.environment,
        triggeredBy: probeRuns.triggeredBy,
        familiesPlanned: probeRuns.familiesPlanned,
        familiesExecuted: probeRuns.familiesExecuted,
        requestsMade: probeRuns.requestsMade,
        effectsUsed: probeRuns.effectsUsed,
        createdCount: probeRuns.createdCount,
        deletedConfirmedCount: probeRuns.deletedConfirmedCount,
        quarantinedCount: probeRuns.quarantinedCount,
        abortedReason: probeRuns.abortedReason,
        errorCode: probeRuns.errorCode,
        startedAt: probeRuns.startedAt,
        completedAt: probeRuns.completedAt,
      })
      .from(probeRuns)
      .where(eq(probeRuns.apiId, api.id))
      .orderBy(desc(probeRuns.startedAt))
      .limit(10),
    db
      .select({ status: probeResources.cleanupStatus, count: sql<number>`count(*)::int` })
      .from(probeResources)
      .where(and(eq(probeResources.apiId, api.id), inArray(probeResources.cleanupStatus, ['deleted_unconfirmed', 'delete_failed', 'quarantined'])))
      .groupBy(probeResources.cleanupStatus),
    db
      .select({ writeConsentAt: credentials.writeConsentAt, lastProbeRunAt: credentials.lastProbeRunAt })
      .from(credentials)
      .where(and(eq(credentials.apiId, api.id), eq(credentials.environment, 'sandbox')))
      .limit(1),
  ]);

  const byStatus = new Map(counts.map((c) => [c.status, c.count]));
  const quarantined = byStatus.get('quarantined') ?? 0;
  const unresolved = (byStatus.get('deleted_unconfirmed') ?? 0) + (byStatus.get('delete_failed') ?? 0);
  // A fixture the runner could not remove is a create whose contract was not
  // honoured — R3 until a reviewer accepts it. accepted_quarantine rows are
  // excluded above, so this is the unaccepted set.
  const release = releaseBlocked(Array.from({ length: quarantined }, () => ({ risk: 'R3' as const })), false);

  return Response.json({
    runs,
    quarantined,
    unresolved,
    releaseBlocked: release.blocked,
    canRun: Boolean(cred?.writeConsentAt),
    lastProbeRunAt: cred?.lastProbeRunAt ?? null,
  });
}
