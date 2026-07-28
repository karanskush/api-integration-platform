import { auth } from '@clerk/nextjs/server';
import { and, eq, inArray } from 'drizzle-orm';
import { verifyAnalysisAccessToken } from '@/lib/analysisAccess';
import { resolveAnswer, type AnswerSpec } from '@/lib/clarify';
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
  let skippedCount = 0;
  let reopenedCount = 0;
  const rejected: Array<{ clarificationId: string; reason: string }> = [];

  for (const raw of answers) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as {
      clarificationId?: unknown;
      choice?: unknown;
      other?: unknown;
      values?: unknown;
      skip?: unknown;
      reopen?: unknown;
    };
    const clarificationId = typeof entry.clarificationId === 'string' ? entry.clarificationId : '';
    if (!clarificationId) continue;

    const [row] = await db
      .select()
      .from(clarifications)
      .where(
        and(
          eq(clarifications.id, clarificationId),
          eq(clarifications.apiId, api.id),
          // An assumption is answerable too: triage downgraded the question, it
          // did not settle it. Anything already answered or skipped is not.
          inArray(clarifications.status, ['pending', 'assumed']),
        ),
      )
      .limit(1);
    if (!row) continue; // already resolved, or belongs to a different API — silently ignored, not an error

    specVersionId = row.specVersionId;

    // "That inference is wrong — put the question back to me." Clears the
    // assumption entirely rather than recording a negative, so the field falls
    // back to its heuristic origin and the question returns to the quiz.
    if (entry.reopen === true) {
      await db
        .update(clarifications)
        .set({ status: 'pending', answerSource: 'human', assumedAnswer: null, assumedBasis: null })
        .where(eq(clarifications.id, clarificationId));
      reopenedCount++;
      continue;
    }

    // A skip is a real answer — "we asked, nobody could say" — and the honest
    // way to unblock an analysis pinned on a question no one can resolve. It
    // records no evidence, because not knowing is not a fact about the API.
    if (entry.skip === true) {
      await db
        .update(clarifications)
        .set({ status: 'skipped', answeredBy: answeredByUserId, answeredAt: new Date() })
        .where(eq(clarifications.id, clarificationId));
      skippedCount++;
      continue;
    }

    const resolved = resolveAnswer(row.answerSpec as AnswerSpec | null, entry);
    if ('reason' in resolved) {
      rejected.push({ clarificationId, reason: resolved.reason });
      continue;
    }

    await db
      .update(clarifications)
      .set({
        status: 'answered',
        answer: resolved.answer,
        answerSource: 'human',
        answeredBy: answeredByUserId,
        answeredAt: new Date(),
        // A person's answer supersedes whatever triage inferred, so the stale
        // assumption is cleared rather than left to contradict it.
        assumedAnswer: null,
        assumedBasis: null,
      })
      .where(eq(clarifications.id, clarificationId));
    // Highest-trust evidence tier — a person confirmed this directly, above
    // both heuristic (source: 'parser') and LLM-inferred (source: 'llm') facts.
    await db.insert(evidenceFacts).values({
      apiId: api.id,
      specVersionId: row.specVersionId,
      kind: 'human.clarification',
      source: 'human',
      confidence: 1,
      payload: { clarificationId: row.id, question: row.question, answer: resolved.answer },
    });
    answeredCount++;
  }

  // A skip-only submission is a legitimate one, so the "nothing matched" case is
  // answered + skipped, not answered alone. Rejections are reported rather than
  // silently dropped: previously a malformed entry produced a bare 404 that gave
  // the client nothing to show.
  if (!answeredCount && !skippedCount && !reopenedCount) {
    return Response.json(
      rejected.length
        ? { error: 'No answer could be accepted', rejected }
        : { error: 'No matching pending clarifications were found' },
      { status: rejected.length ? 400 : 404 },
    );
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

  return Response.json({
    ok: true,
    answered: answeredCount,
    skipped: skippedCount,
    reopened: reopenedCount,
    remaining: remaining.length,
    ...(rejected.length ? { rejected } : {}),
  });
}
