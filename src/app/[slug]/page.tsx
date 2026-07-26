import { auth } from '@clerk/nextjs/server';
import { and, eq } from 'drizzle-orm';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import ActionCard from '@/components/ActionCard';
import AuthGuide from '@/components/AuthGuide';
import ClaimOwnershipForm from '@/components/ClaimOwnershipForm';
import McpBlock from '@/components/McpBlock';
import Playground from '@/components/Playground';
import RunVerificationButton from '@/components/RunVerificationButton';
import ScorePreviewPanel from '@/components/ScorePreviewPanel';
import VerifiedScorePanel from '@/components/VerifiedScorePanel';
import { getDb } from '@/lib/db';
import { orgMembers, users } from '@/lib/db/schema';
import { loadApiVerificationState, loadPersistentRecord } from '@/lib/persistentApi';
import { canViewApi } from '@/lib/visibility';

// ISR with on-demand purging: api/ci/sync and the verification run both call
// revalidatePath() for this path now that a re-import write path exists, so the
// hour below is a backstop rather than the only refresh mechanism.
export const revalidate = 3600;

// Same xReady() gate the rest of the codebase uses for claim/auth UI (see
// dashboard/page.tsx, p/[id]/page.tsx) — without Clerk configured, the page
// still renders, just without the claim/verify affordances.
const clerkReady = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

const SOURCE_LABEL: Record<string, string> = {
  openapi: 'OpenAPI 3.x',
  swagger: 'Swagger 2.0',
  postman: 'Postman collection',
  curl: 'cURL import',
};

function appOrigin(): string {
  return process.env.PUBLIC_APP_ORIGIN?.replace(/\/$/, '') || 'http://localhost:3000';
}

// Best-effort hostname for pre-filling the claim form — mirrors claim/verify
// route's own apiDomain() derivation.
function baseUrlHostname(baseUrls: string[]): string {
  if (!baseUrls.length) return '';
  try {
    return new URL(baseUrls[0]).hostname;
  } catch {
    return '';
  }
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const record = await loadPersistentRecord(slug);
  return { title: record ? `${record.name} — Spotcheck` : 'Not found — Spotcheck' };
}

export default async function PersistentApiPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const record = await loadPersistentRecord(slug);
  if (!record) notFound();

  const verification = await loadApiVerificationState(slug);
  const { userId } = clerkReady ? await auth() : { userId: null };

  // A private API is 404 to everyone outside its org — not 403, which would
  // confirm the slug exists (see visibility.ts).
  if (!(await canViewApi(slug, userId))) notFound();

  let canVerify = false;
  if (userId && verification?.claimStatus === 'claimed') {
    const db = getDb();
    const membership = await db
      .select({ userId: users.id })
      .from(users)
      .innerJoin(orgMembers, eq(orgMembers.userId, users.id))
      .where(and(eq(users.clerkUserId, userId), eq(orgMembers.orgId, verification.orgId)))
      .limit(1);
    canVerify = membership.length > 0;
  }

  const mcpUrl = `${appOrigin()}/mcp/${record.id}`;

  return (
    <div className="product-page wrap" style={{ display: 'grid', gap: 20 }}>
      <header>
        <h1 className="display" style={{ fontSize: 26 }}>{record.name}</h1>
        <p className="mono" style={{ color: 'var(--fg-mute)', fontSize: 12.5, marginTop: 6 }}>
          {SOURCE_LABEL[record.source] ?? record.source} · {record.counts.total} endpoint
          {record.counts.total === 1 ? '' : 's'} · {record.counts.read} read / {record.counts.write}{' '}
          write / {record.counts.destructive} destructive
        </p>
        {record.baseUrls.length > 0 ? (
          <p className="mono" style={{ color: 'var(--fg-dim)', fontSize: 12.5, marginTop: 4 }}>
            base URL: {record.baseUrls.join(' · ')}
          </p>
        ) : (
          <p style={{ color: 'var(--accent-red)', fontSize: 12.5, marginTop: 4 }}>
            No public base URL detected in the spec — playground and MCP calls are disabled.
          </p>
        )}
      </header>

      {verification?.claimStatus === 'unclaimed' && (
        <section className="panel" style={{ padding: 20 }}>
          <h2 style={{ fontSize: 15, marginBottom: 6 }}>
            Unofficial <span className="chip" style={{ marginLeft: 8 }}>not verified by the provider</span>
          </h2>
          <p style={{ color: 'var(--fg-dim)', fontSize: 13.5, marginBottom: 14 }}>
            This page was generated from a public spec — nobody has claimed ownership of it yet. If
            you run this API, verify your domain to take it over and unlock live verification.
          </p>
          {clerkReady ? (
            userId ? (
              <ClaimOwnershipForm slug={slug} defaultDomain={baseUrlHostname(record.baseUrls)} />
            ) : (
              <a className="btn primary" href="/sign-in">
                Sign in to claim this API
              </a>
            )
          ) : (
            <p style={{ color: 'var(--fg-mute)', fontSize: 12.5 }}>
              Claiming isn&apos;t configured on this deployment yet.
            </p>
          )}
        </section>
      )}

      <AuthGuide record={record} />
      {verification?.scores ? <VerifiedScorePanel scores={verification.scores} /> : <ScorePreviewPanel record={record} />}
      {canVerify && <RunVerificationButton slug={slug} authRequired={record.auth !== 'none'} />}
      <McpBlock record={record} mcpUrl={mcpUrl} />

      {record.baseUrls.length > 0 && (
        <section className="panel" style={{ padding: 20 }}>
          <h2 style={{ fontSize: 15, marginBottom: 12 }}>Playground</h2>
          <Playground
            id={record.id}
            actions={record.actions}
            baseUrls={record.baseUrls}
            auth={record.auth}
            authIn={record.authIn}
          />
        </section>
      )}

      <section style={{ display: 'grid', gap: 14 }}>
        <h2 style={{ fontSize: 15 }}>Actions</h2>
        {record.actions.map((a) => (
          <ActionCard key={a.id} action={a} record={record} />
        ))}
      </section>
    </div>
  );
}
