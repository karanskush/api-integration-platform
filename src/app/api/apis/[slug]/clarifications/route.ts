import { auth } from '@clerk/nextjs/server';
import { and, eq } from 'drizzle-orm';
import { verifyAnalysisAccessToken } from '@/lib/analysisAccess';
import { getDb } from '@/lib/db';
import { apis, clarifications, evidenceFacts, orgMembers, users } from '@/lib/db/schema';
import { publishJob, queueReady } from '@/lib/queue';
import { getLimiter, tooMany } from '@/lib/ratelimit';

export const maxDuration = 30;

type ApiRow = { id: string; orgId: string };

// Two ways in: the signed cross-device token from the clarification email
// (works with no Clerk session at all — the whole point of emailing a link),
// or a signed-in user who is actually a member of the API's org (same
// membership check [slug]/page.tsx already uses for its own "can verify"
// gate). Neither alone is assumed sufficient without checking — a present
// but invalid/expired token falls through to the membership check rather
// than being treated as an error.
async function isAuthorized(req: Request, api: ApiRow): Promise<boolean> {
  const token = new URL(req.url).searchParams.get('token');
  if (verifyAnalysisAccessToken(token, api.id)) return true;

  const { userId } = await auth();
  if (!userId) return false;
  const db = getDb();
  const membership = await db
    .select({ userId: users.id })
    .from(users)
    .innerJoin(orgMembers, eq(orgMembers.userId, users.id))
    .where(and(eq(users.clerkUserId, userId), eq(orgMembers.orgId, api.orgId)))
    .limit(1);
  return membership.length > 0;
}

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const db = getDb();

  const [api] = await db.select().from(apis).where(eq(apis.slug, slug)).limit(1);
  if (!api) return Response.json({ error: 'Unknown API' }, { status: 404 });

  if (!(await isAuthorized(req, api))) {
    return Response.json({ error: 'Not authorized to answer clarifications for this API' }, { status: 403 });
  }

  const rl = await getLimiter('clarifications-answer', { limit: 30, windowSec: 600 }).limit(api.id);
  if (!rl.success) return tooMany(rl.reset);

  let body: { answers?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const answers = Array.isArray(body.answers) ? body.answers : [];
  if (!answers.length) {
    return Response.json({ error: 'answers is required and must be a non-empty array' }, { status: 400 });
  }

  const { userId: clerkUserId } = await auth();
  let answeredByUserId: string | null = null;
  if (clerkUserId) {
    const [dbUser] = await db.select({ id: users.id }).from(users).where(eq(users.clerkUserId, clerkUserId)).limit(1);
    answeredByUserId = dbUser?.id ?? null;
  }

  let specVersionId: string | null = null;
  let answeredCount = 0;

  for (const raw of answers) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as { clarificationId?: unknown; answer?: unknown };
    const clarificationId = typeof entry.clarificationId === 'string' ? entry.clarificationId : '';
    if (!clarificationId || entry.answer === undefined) continue;

    const [row] = await db
      .select()
      .from(clarifications)
      .where(
        and(eq(clarifications.id, clarificationId), eq(clarifications.apiId, api.id), eq(clarifications.status, 'pending')),
      )
      .limit(1);
    if (!row) continue; // already answered, skipped, or belongs to a different API — silently ignored, not an error

    specVersionId = row.specVersionId;
    await db
      .update(clarifications)
      .set({ status: 'answered', answer: entry.answer, answeredBy: answeredByUserId, answeredAt: new Date() })
      .where(eq(clarifications.id, clarificationId));
    // Highest-trust evidence tier — a person confirmed this directly, above
    // both heuristic (source: 'parser') and LLM-inferred (source: 'llm') facts.
    await db.insert(evidenceFacts).values({
      apiId: api.id,
      specVersionId: row.specVersionId,
      kind: 'human.clarification',
      source: 'human',
      confidence: 1,
      payload: { clarificationId: row.id, question: row.question, answer: entry.answer },
    });
    answeredCount++;
  }

  if (!answeredCount) {
    return Response.json({ error: 'No matching pending clarifications were found' }, { status: 404 });
  }

  const remaining = await db
    .select({ id: clarifications.id })
    .from(clarifications)
    .where(and(eq(clarifications.apiId, api.id), eq(clarifications.status, 'pending')));

  // Zero left: re-trigger finalize so it generates the artifacts and sends
  // the "ready" email — the same job the enrich stage already chains to, now
  // fired again because the picture just changed.
  if (remaining.length === 0 && specVersionId && queueReady()) {
    await publishJob('/api/jobs/analyze-finalize', { apiId: api.id, specVersionId });
  }

  return Response.json({ ok: true, answered: answeredCount, remaining: remaining.length });
}
