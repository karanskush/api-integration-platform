import { auth } from '@clerk/nextjs/server';
import { and, eq } from 'drizzle-orm';
import { dbReady, getDb } from '@/lib/db';
import { apis, orgMembers, orgs, scoreRuns, users } from '@/lib/db/schema';
import { buildExecutionPlan } from '@/lib/lineagePlan';
import { applyLineageRun } from '@/lib/lineageRun';
import { loadPersistentRecord } from '@/lib/persistentApi';
import { PLAN_LIMITS, outboundDeadlineMs, outboundRequestsPerRun, type Plan } from '@/lib/plans';
import { createBudget, withBudget } from '@/lib/probes/budget';
import { runLineageChains } from '@/lib/probes/lineageChain';
import { invokeAction } from '@/lib/mcpTools';
import { runScoreEngine } from '@/lib/probes/run';
import { purgeApiSurfaces } from '@/lib/purge';
import { getLimiter, tooMany } from '@/lib/ratelimit';
import { actorHashForToken } from '@/lib/mcpAccess';
import { selectProbeAuth } from '@/lib/probeCredential';
import type { ProbeEnvironment } from '@/lib/probes/types';
import { probePaceMs } from '@/lib/reverify';
import { applyEvidenceFacts, applyScoreRun } from '@/lib/scoreWrite';

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

  // Needed for the chain-verification gate below; the score run itself is
  // available on every plan and stays that way.
  const [org] = await db.select({ plan: orgs.plan }).from(orgs).where(eq(orgs.id, api.orgId)).limit(1);
  const orgPlan = org?.plan ?? 'free';

  if (api.claimStatus !== 'claimed') {
    return Response.json(
      { error: 'This API has not been claimed yet — there is no owner authorized to run a verification.' },
      { status: 409 },
    );
  }

  const rl = await getLimiter('score-run', { limit: 1, windowSec: 3600 }).limit(api.orgId);
  if (!rl.success) return tooMany(rl.reset);

  let body: { upstreamKey?: unknown; environment?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const pastedKey = typeof body.upstreamKey === 'string' && body.upstreamKey.trim() ? body.upstreamKey.trim() : undefined;
  const declared = typeof body.environment === 'string' ? body.environment.trim().toLowerCase() : 'production';
  if (declared !== 'production' && declared !== 'sandbox') {
    return Response.json({ error: 'environment must be production or sandbox' }, { status: 400 });
  }

  // A pasted key is used once and discarded, in the environment the caller
  // declared. Without one, the org's vault decides: production on Team+, else
  // a sandbox credential on any plan, else the reads run unauthenticated.
  const probeAuth = await selectProbeAuth(db, {
    orgId: api.orgId,
    apiId: api.id,
    plan: orgPlan,
    actor: { type: 'probe', hash: actorHashForToken(userId) },
    byok: pastedKey ? { key: pastedKey, environment: declared as ProbeEnvironment } : null,
  });
  const upstreamKey = probeAuth.upstreamKey;
  const environment: ProbeEnvironment = probeAuth.environment;
  const credentialId = probeAuth.credentialId;

  const record = await loadPersistentRecord(slug);
  if (!record) return Response.json({ error: 'Unknown API' }, { status: 404 });

  // One ceiling for the whole run, applied at the seam every probe already
  // calls through — the same wiring reverifyOne uses.
  const budgetLimit = outboundRequestsPerRun();
  const budget = createBudget({ maxRequests: budgetLimit, deadlineMs: outboundDeadlineMs() });
  const budgetedInvoke = withBudget(invokeAction, budget);

  const [run] = await db
    .insert(scoreRuns)
    .values({ apiId: api.id, status: 'running', environment, credentialId, trigger: 'manual' })
    .returning();

  try {
    const result = await runScoreEngine(record, {
      upstreamKey,
      invoke: budgetedInvoke,
      budget,
      environment,
      runId: run.id,
      paceMs: probePaceMs(),
    });

    await applyScoreRun(db, {
      apiId: api.id,
      specVersionId: api.currentSpecVersionId!,
      environment,
      credentialId,
      total: result.total,
      subscores: result.subscores,
      liveCalls: result.liveCalls,
      points: result.points,
      evidence: result.evidence,
    });

    await db
      .update(scoreRuns)
      .set({
        status: 'succeeded',
        findings: result,
        probesRun: { version: 1, environment, stages: result.stages },
        completedAt: new Date(),
      })
      .where(eq(scoreRuns.id, run.id));

    // Executed Lineage on the manual path too.
    //
    // This was deferred on the reasoning that "a single BYOK run cannot satisfy
    // the cross-run rule". That was wrong, and lineageVerdict.ts says so: only
    // REFUTATION needs two runs to agree. A confirmation needs one — so an
    // owner who clicks verify with their own key can get a proven link back
    // immediately, rather than waiting for a scheduled run they may not be on a
    // plan to receive.
    //
    // Isolated the same way the canary is in reverifyOne: a failure here must
    // never undo the score written above.
    let chains: { planned: number; executed: number; confirmed: number } | undefined;
    const plan = PLAN_LIMITS[(orgPlan as Plan) in PLAN_LIMITS ? (orgPlan as Plan) : 'free'];
    if (plan.chainVerification) {
      try {
        const executionPlan = buildExecutionPlan(record);
        const chainResult = await runLineageChains(
          { record, upstreamKey, invoke: budgetedInvoke, budget, environment },
          executionPlan,
        );
        if (chainResult.evidence?.length) {
          await applyEvidenceFacts(db, {
            apiId: api.id,
            specVersionId: api.currentSpecVersionId!,
            environment,
            evidence: chainResult.evidence,
          });
        }
        const applied = await applyLineageRun(db, {
          apiId: api.id,
          specVersionId: api.currentSpecVersionId!,
          environment,
          credentialId,
          chainsPlanned: executionPlan.chains.length,
          budgetLimit,
          result: chainResult,
        });
        chains = {
          planned: executionPlan.chains.length,
          executed: chainResult.observations.length,
          confirmed: applied.confirmed,
        };
      } catch (err) {
        // Name only: ssrf.ts throws `Invalid URL: <url>`, and for an executed
        // chain that URL carries the extracted identifier.
        console.error('[verify] chain run failed', {
          slug,
          reason: err instanceof Error ? err.name : 'unknown',
        });
      }
    }

    // A new verified score changes the page's score panel, the badge colour,
    // and the badge manifest, so none may serve its cached pre-run version.
    purgeApiSurfaces(slug);

    return Response.json({
      ...result,
      usedVaultedCredential: probeAuth.kind === 'vault',
      credentialLabel: probeAuth.label,
      ...(chains ? { chains } : {}),
    });
  } catch {
    console.error('[verify]', { slug, apiId: api.id });
    await db
      .update(scoreRuns)
      .set({ status: 'failed', error: 'Verification run failed', completedAt: new Date() })
      .where(eq(scoreRuns.id, run.id));
    return Response.json({ error: 'Verification run failed' }, { status: 500 });
  }
}
