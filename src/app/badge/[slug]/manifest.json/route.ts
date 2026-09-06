import { eq } from 'drizzle-orm';
import { changeSummary } from '@/lib/changes/query';
import { dbReady, getDb } from '@/lib/db';
import { apis, scores, specVersions } from '@/lib/db/schema';
import { isPrivate } from '@/lib/visibility';

// A sibling cached route rather than a `?format=json` branch on the badge
// itself: reading a search param would make that route dynamic, and a dynamic
// route cannot be purged — the badge would lose the on-demand invalidation its
// whole design depends on.
export const revalidate = 3600;

// What the badge stands for, in machine-readable form. A badge is the only
// DocentAPI surface most consumers ever see; this is how a reader gets from
// the number to its scope — which spec version earned it, whether that version
// is still current, when the spec was last checked, and how much has changed.
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;

  const notFound = () => Response.json({ error: 'Unknown API' }, { status: 404 });
  // Never 500 on a public surface: an unconfigured deployment reports that it
  // cannot verify, the same stance the SVG badge takes.
  if (!dbReady()) return Response.json({ slug, verified: false, reason: 'persistence_unconfigured' });

  const db = getDb();
  const [row] = await db
    .select({
      apiId: apis.id,
      claimStatus: apis.claimStatus,
      visibility: apis.visibility,
      currentSpecVersionId: apis.currentSpecVersionId,
      total: scores.total,
      verifiedAt: scores.verifiedAt,
      scoreSpecVersionId: scores.specVersionId,
      currentVersionHash: specVersions.contentHash,
    })
    .from(apis)
    .leftJoin(scores, eq(scores.apiId, apis.id))
    .leftJoin(specVersions, eq(specVersions.id, apis.currentSpecVersionId))
    .where(eq(apis.slug, slug))
    .limit(1);

  if (!row || isPrivate(row.visibility)) return notFound();

  const summary = await changeSummary(db, row.apiId);
  const stale = row.total != null && row.scoreSpecVersionId !== row.currentSpecVersionId;

  return Response.json(
    {
      slug,
      verified: row.claimStatus === 'claimed' && row.total != null && !stale,
      score: row.total ?? null,
      // A stale score is still a real measurement — of a superseded contract.
      stale,
      verifiedAt: row.verifiedAt?.toISOString() ?? null,
      specVersion: row.currentVersionHash?.slice(0, 12) ?? null,
      lastCheckedAt: summary.lastCheckedAt,
      lastChangeAt: summary.lastChangeAt,
      changes30d: summary.counts30d,
      changelogUrl: `/${slug}/changes`,
    },
    { headers: { 'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400' } },
  );
}
