import { auth } from '@clerk/nextjs/server';
import { and, eq } from 'drizzle-orm';
import { dbReady, getDb } from '@/lib/db';
import { apis, credentials, orgMembers, users } from '@/lib/db/schema';
import { enqueueSandboxWriteRun } from '@/lib/probeJobs';
import { getLimiter, tooMany } from '@/lib/ratelimit';

// The owner's button: queue one sandbox write run (probes/writeRunner.ts) for
// this API. Nothing runs inline — the job route holds the budgets, the policy
// gate and the ledger — and nothing runs at all without a stored SANDBOX key
// carrying write consent. Two per org per hour: every run creates and deletes
// real objects in the owner's test environment.
export async function POST(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
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
  if (api.claimStatus !== 'claimed' || !api.currentSpecVersionId) {
    return Response.json({ error: 'This API has not been claimed yet — there is no owner authorized to run a probe.' }, { status: 409 });
  }

  const [cred] = await db
    .select({ id: credentials.id, writeConsentAt: credentials.writeConsentAt })
    .from(credentials)
    .where(and(eq(credentials.apiId, api.id), eq(credentials.environment, 'sandbox')))
    .limit(1);
  if (!cred) return Response.json({ error: 'Store a sandbox key first — writes only ever run against a sandbox you connect.' }, { status: 409 });
  if (!cred.writeConsentAt) {
    return Response.json({ error: 'Writes with cleanup are switched off for your sandbox key. Tick the consent on the sandbox credential panel to run them.' }, { status: 409 });
  }

  const rl = await getLimiter('probe-run', { limit: 2, windowSec: 3600 }).limit(api.orgId);
  if (!rl.success) return tooMany(rl.reset);

  const result = await enqueueSandboxWriteRun(db, {
    apiId: api.id,
    specVersionId: api.currentSpecVersionId,
    credentialId: cred.id,
    triggeredBy: 'owner',
  });
  if (!result.queued) return Response.json({ error: 'The job queue is not configured' }, { status: 503 });
  return Response.json({ queued: true, runId: result.runId }, { status: 202 });
}
