import { eq } from 'drizzle-orm';
import { badgeSvg } from '@/lib/badge';
import { dbReady, getDb } from '@/lib/db';
import { apis, scores } from '@/lib/db/schema';

export const dynamic = 'force-dynamic';

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
  return badgeResponse(badgeSvg({ label: 'spotcheck', message: 'unverified', color: UNVERIFIED_COLOR }));
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
    .select({ claimStatus: apis.claimStatus, total: scores.total })
    .from(apis)
    .leftJoin(scores, eq(scores.apiId, apis.id))
    .where(eq(apis.slug, slug))
    .limit(1);

  if (!row) {
    return Response.json({ error: 'Unknown API' }, { status: 404 });
  }

  if (row.claimStatus !== 'claimed' || row.total == null) {
    return unverifiedBadge();
  }

  return badgeResponse(badgeSvg({ label: 'agent-ready', message: `${row.total}/100`, color: VERIFIED_COLOR }));
}
