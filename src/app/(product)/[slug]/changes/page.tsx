import { auth } from '@clerk/nextjs/server';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import ChangeList from '@/components/product/ChangeList';
import FreshnessStrip from '@/components/product/FreshnessStrip';
import { changeSummary, groupIntoReleases, listChanges } from '@/lib/changes/query';
import { formatUtcDate } from '@/lib/changes/time';
import { dbReady, getDb } from '@/lib/db';
import { loadApiVerificationState } from '@/lib/persistentApi';
import { canViewApi } from '@/lib/visibility';

// ISR with on-demand purge, like the API page itself: every write path calls
// purgeApiSurfaces(), which includes this path, so the hour is a backstop
// rather than the mechanism.
export const revalidate = 3600;

const clerkReady = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

// How much history one page renders. Deep history lives in the JSON API.
const PAGE_LIMIT = 200;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const state = dbReady() ? await loadApiVerificationState(slug) : null;
  return { title: state ? `Changes — ${state.name} — DocentAPI` : 'Not found — DocentAPI' };
}

export default async function ApiChangesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!dbReady()) notFound();

  const state = await loadApiVerificationState(slug);
  if (!state) notFound();

  const { userId } = clerkReady ? await auth() : { userId: null };
  // Private is 404 to everyone outside the org — not 403, which would confirm
  // the slug exists (visibility.ts).
  if (!(await canViewApi(slug, userId))) notFound();

  const db = getDb();
  const [rows, summary] = await Promise.all([
    listChanges(db, state.apiId, { limit: PAGE_LIMIT }),
    changeSummary(db, state.apiId),
  ]);
  const releases = groupIntoReleases(rows);

  return (
    <div className="product-page wrap" style={{ display: 'grid', gap: 20 }}>
      <header>
        <p className="eyebrow" style={{ marginBottom: 6 }}>
          <Link href={`/${slug}`} style={{ color: 'var(--fg-mute)' }}>
            ← {state.name}
          </Link>
        </p>
        <h1 className="display" style={{ fontSize: 26 }}>
          Changes
        </h1>
        <p style={{ color: 'var(--fg-dim)', fontSize: 13.5, marginTop: 6, maxWidth: '60ch' }}>
          Every classified change to this API&apos;s contract and observed lifecycle: what changed, how badly it can
          break an existing integration, and which spec version it landed in.
        </p>
        <p className="mono" style={{ color: 'var(--fg-mute)', fontSize: 12.5, marginTop: 8 }}>
          <a href={`/${slug}/changes/feed.xml`}>RSS</a> · <a href={`/api/apis/${slug}/changes`}>JSON</a>
          {summary.currentVersionHash ? ` · current spec ${summary.currentVersionHash.slice(0, 12)}` : ''}
        </p>
      </header>

      <FreshnessStrip slug={slug} summary={summary} stale={state.scores?.stale} />

      {releases.length === 0 ? (
        <section className="panel" style={{ padding: 20 }}>
          <h2 style={{ fontSize: 15, marginBottom: 6 }}>No changes recorded yet</h2>
          <p style={{ color: 'var(--fg-dim)', fontSize: 13.5 }}>
            This API was first imported on {formatUtcDate(summary.lastCheckedAt)}. Nothing in its contract has changed
            since, and the spec was last checked {formatUtcDate(summary.lastCheckedAt)}. Changes appear here
            automatically as they are detected.
          </p>
        </section>
      ) : (
        <ChangeList releases={releases} />
      )}

      {rows.length >= PAGE_LIMIT && (
        <p style={{ color: 'var(--fg-mute)', fontSize: 12.5 }}>
          Showing the most recent {PAGE_LIMIT} changes. Older history is available through the{' '}
          <a href={`/api/apis/${slug}/changes`}>JSON API</a>.
        </p>
      )}
    </div>
  );
}
