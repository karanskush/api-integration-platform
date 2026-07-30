import { eq } from 'drizzle-orm';
import { badgeSvg } from '@/lib/badge';
import { dbReady, getDb } from '@/lib/db';
import { apis, scores } from '@/lib/db/schema';
import { isPrivate } from '@/lib/visibility';

// Cached, not force-dynamic: badges are embedded in READMEs and hit far more
// often than scores change, and a force-dynamic route can't be purged — the
// hour of CDN Cache-Control below would have been unrevokable, so a badge could
// keep advertising a score after a re-import invalidated it. As a cached route
// it is purged on demand by revalidatePath(`/badge/${slug}`) from api/ci/sync
// and the verification run.
export const revalidate = 3600;

const UNVERIFIED_COLOR = '#8a8f98';
const VERIFIED_COLOR = '#43d9a3'; // --accent-green in globals.css — earned, verified only

function badgeResponse(svg: string): Response {
  return new Response(svg, {
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
    },
  });
}

function unverifiedBadge(): Response {
  return badgeResponse(badgeSvg({ label: 'docentapi', message: 'unverified', color: UNVERIFIED_COLOR }));
}

// Public, unauthenticated badge — reads apis+scores directly rather than
// loadPersistentRecord() (that reshapes into ImportRecord, which this route
// has no use for). Unclaimed/unscored pages still get 200 + a neutral badge,
// never a provider-endorsement-implying green, per this feature's release
// gate — dbReady()==false is likewise treated as "can't verify right now",
// not an error: public badges must never 500.
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;

  if (!dbReady()) return unverifiedBadge();

  const db = getDb();
  const [row] = await db
    .select({ claimStatus: apis.claimStatus, visibility: apis.visibility, total: scores.total })
    .from(apis)
    .leftJoin(scores, eq(scores.apiId, apis.id))
    .where(eq(apis.slug, slug))
    .limit(1);

  if (!row) {
    return Response.json({ error: 'Unknown API' }, { status: 404 });
  }

  // A badge is an unauthenticated, embeddable, CDN-cached asset — there is no
  // caller identity to check here, so a private API simply has no badge. Same
  // 404 as an unknown slug, so the response reveals nothing either way.
  if (isPrivate(row.visibility)) {
    return Response.json({ error: 'Unknown API' }, { status: 404 });
  }

  if (row.claimStatus !== 'claimed' || row.total == null) {
    return unverifiedBadge();
  }

  return badgeResponse(badgeSvg({ label: 'agent-ready', message: `${row.total}/100`, color: VERIFIED_COLOR }));
}
