import { auth } from '@clerk/nextjs/server';
import { and, eq, inArray } from 'drizzle-orm';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import AssumptionsPanel, { type PanelAssumption } from '@/components/AssumptionsPanel';
import ClarificationForm, { type QuizAnswerSpec } from '@/components/ClarificationForm';
import { verifyAnalysisAccessToken } from '@/lib/analysisAccess';
import { dbReady, getDb } from '@/lib/db';
import { apis, clarifications, orgMembers, users } from '@/lib/db/schema';

const clerkReady = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  return { title: `Finish setting up — ${slug} — Spotcheck` };
}

// The clarification email's landing page. Reachable two ways: the signed
// cross-device token in the email link (works with no Clerk session at all),
// or a signed-in user who is a member of the API's org — same membership
// check [slug]/page.tsx already uses for its own claim-verification gate.
export default async function CompletePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  const { slug } = await params;
  const { token } = await searchParams;

  if (!dbReady()) notFound();
  const db = getDb();

  const [api] = await db.select().from(apis).where(eq(apis.slug, slug)).limit(1);
  if (!api) notFound();

  const tokenValid = verifyAnalysisAccessToken(token, api.id);
  let authorized = tokenValid;

  if (!authorized && clerkReady) {
    const { userId } = await auth();
    if (userId) {
      const membership = await db
        .select({ userId: users.id })
        .from(users)
        .innerJoin(orgMembers, eq(orgMembers.userId, users.id))
        .where(and(eq(users.clerkUserId, userId), eq(orgMembers.orgId, api.orgId)))
        .limit(1);
      authorized = membership.length > 0;
    }
  }

  if (!authorized) {
    if (!clerkReady) notFound();
    return (
      <div className="wrap" style={{ padding: '60px 0', textAlign: 'center', display: 'grid', gap: 12, justifyItems: 'center' }}>
        <p style={{ color: 'var(--fg-dim)' }}>Sign in as the owner of this API to finish setting it up.</p>
        <a className="btn primary" href="/sign-in">
          Sign in
        </a>
      </div>
    );
  }

  // Ordered explicitly: with one question at a time, an unordered read means a
  // refresh reshuffles the quiz mid-way. created_at already reflects the
  // archetype rank the enrich job inserted in, so concrete questions come first.
  const rows = await db
    .select()
    .from(clarifications)
    .where(and(eq(clarifications.apiId, api.id), inArray(clarifications.status, ['pending', 'assumed'])))
    .orderBy(clarifications.createdAt, clarifications.id);

  const pending = rows.filter((r) => r.status === 'pending');

  // Assumed rows are not blocking and are not part of the quiz — they render
  // below it, with the sentence relied on, so the owner can disagree in one
  // click. An assumption whose answer no longer matches its recorded options is
  // dropped rather than shown with a raw value: if we cannot say what we
  // concluded in the owner's own words, we have no business claiming it.
  const assumptions: PanelAssumption[] = rows.flatMap((r) => {
    if (r.status !== 'assumed') return [];
    const spec = r.answerSpec as QuizAnswerSpec | null;
    const basis = r.assumedBasis as { quote?: string; sourceKind?: string; sourceUrl?: string } | null;
    const chosen = typeof r.assumedAnswer === 'string' ? r.assumedAnswer : null;
    const label = spec?.options?.find((o) => o.value === chosen)?.label;
    if (!basis?.quote || !label) return [];
    return [{
      id: r.id,
      question: r.question,
      ...(r.fieldPath ? { fieldPath: r.fieldPath } : {}),
      answerLabel: label,
      quote: basis.quote,
      sourceKind: basis.sourceKind ?? 'spec_field',
      ...(basis.sourceUrl ? { sourceUrl: basis.sourceUrl } : {}),
    }];
  });

  return (
    <div className="wrap" style={{ padding: '40px 0', display: 'grid', gap: 20, maxWidth: 640, margin: '0 auto' }}>
      <header>
        <span className="eyebrow">Finish setting up</span>
        <h1 className="display" style={{ fontSize: 26 }}>
          {api.name}
        </h1>
        <p style={{ color: 'var(--fg-dim)', fontSize: 13.5, marginTop: 8 }}>
          {pending.length === 0
            ? assumptions.length > 0
              ? 'Nothing needs answering. Have a look at what we worked out below, in case any of it is wrong.'
              : "Everything's answered — this API is fully analyzed."
            : `We couldn't confidently resolve ${pending.length} thing${pending.length === 1 ? '' : 's'} on our own. Your answers become the authoritative record for this API.`}
        </p>
      </header>
      {pending.length > 0 && (
        <ClarificationForm
          slug={slug}
          token={tokenValid ? token : undefined}
          questions={pending.map((q) => ({
            id: q.id,
            question: q.question,
            fieldPath: q.fieldPath ?? undefined,
            answerSpec: (q.answerSpec as QuizAnswerSpec | null) ?? undefined,
            appliesTo: (q.appliesTo as Array<{ tool: string; fieldPath: string }> | null) ?? undefined,
          }))}
        />
      )}
      <AssumptionsPanel slug={slug} token={tokenValid ? token : undefined} assumptions={assumptions} />
    </div>
  );
}
