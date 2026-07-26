import { auth } from '@clerk/nextjs/server';
import { and, eq } from 'drizzle-orm';
import { dbReady, getDb } from '@/lib/db';
import { apis, orgMembers, scoreRuns, users } from '@/lib/db/schema';
import { loadPersistentRecord } from '@/lib/persistentApi';
import { runScoreEngine } from '@/lib/probes/run';
import { getLimiter, tooMany } from '@/lib/ratelimit';
import { applyScoreRun } from '@/lib/scoreWrite';

export const maxDuration = 60;

// Authenticated trigger for a real, live-probed score run (see
// probes/run.ts) — distinct from the free, spec-only scorePreview computed
// at import/persist time. One run per org per hour: probes make real
// upstream requests, so the limit is there to bound abuse of the caller's
// own BYOK key traffic, not just platform load.
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  if (!dbReady()) {
    return Response.json({ error: 'Persistence is not configured — connect Postgres and redeploy' }, { status: 503 });
  }

  const { userId } = await auth();
  if (!userId) return Response.json({ error: 'Sign in required' }, { status: 401 });

  const { slug } = await ctx.params;
  const db = getDb();

  const [api] = await db.select().from(apis).where(eq(apis.slug, slug)).limit(1);
  if (!api) return Response.json({ error: 'Unknown API' }, { status: 404 });

  const membership = await db
    .select({ userId: users.id })
    .from(users)
    .innerJoin(orgMembers, eq(orgMembers.userId, users.id))
    .where(and(eq(users.clerkUserId, userId), eq(orgMembers.orgId, api.orgId)))
    .limit(1);
  if (!membership.length) return Response.json({ error: 'Forbidden' }, { status: 403 });

  if (api.claimStatus !== 'claimed') {
    return Response.json(
      { error: 'This API has not been claimed yet — there is no owner authorized to run a verification.' },
      { status: 409 },
    );
  }

  const rl = await getLimiter('score-run', { limit: 1, windowSec: 3600 }).limit(api.orgId);
  if (!rl.success) return tooMany(rl.reset);

  let body: { upstreamKey?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const upstreamKey = typeof body.upstreamKey === 'string' ? body.upstreamKey : undefined;

  const record = await loadPersistentRecord(slug);
  if (!record) return Response.json({ error: 'Unknown API' }, { status: 404 });

  const [run] = await db.insert(scoreRuns).values({ apiId: api.id, status: 'running' }).returning();

  try {
    const result = await runScoreEngine(record, { upstreamKey });

    await applyScoreRun(db, {
      apiId: api.id,
      specVersionId: api.currentSpecVersionId!,
      total: result.total,
      subscores: result.subscores,
      evidence: result.evidence,
    });

    await db
      .update(scoreRuns)
      .set({ status: 'succeeded', findings: result, completedAt: new Date() })
      .where(eq(scoreRuns.id, run.id));

    return Response.json(result);
  } catch {
    console.error('[verify]', { slug, apiId: api.id });
    await db
      .update(scoreRuns)
      .set({ status: 'failed', error: 'Verification run failed', completedAt: new Date() })
      .where(eq(scoreRuns.id, run.id));
    return Response.json({ error: 'Verification run failed' }, { status: 500 });
  }
}
