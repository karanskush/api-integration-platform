import { auth } from '@clerk/nextjs/server';
import { and, eq, sql } from 'drizzle-orm';
import { ciTokenFor } from '@/lib/ciSync';
import { dbReady, getDb } from '@/lib/db';
import { apis, orgMembers, users } from '@/lib/db/schema';
import { masterKeyReady } from '@/lib/keys';
import { getLimiter, tooMany } from '@/lib/ratelimit';

export const maxDuration = 30;

// Rotation is destructive to every CI runner using the old token, so it is
// deliberately not something you can hammer.
const TOKEN_LIMIT = { limit: 10, windowSec: 3600 };

async function requireOwnership(slug: string, clerkUserId: string) {
  const db = getDb();
  const [api] = await db
    .select({ id: apis.id, orgId: apis.orgId, claimStatus: apis.claimStatus, ciTokenVersion: apis.ciTokenVersion })
    .from(apis)
    .where(eq(apis.slug, slug))
    .limit(1);
  if (!api) return { error: Response.json({ error: 'Unknown API' }, { status: 404 }) };

  const membership = await db
    .select({ userId: users.id })
    .from(users)
    .innerJoin(orgMembers, eq(orgMembers.userId, users.id))
    .where(and(eq(users.clerkUserId, clerkUserId), eq(orgMembers.orgId, api.orgId)))
    .limit(1);
  if (!membership.length) return { error: Response.json({ error: 'Forbidden' }, { status: 403 }) };

  if (api.claimStatus !== 'claimed') {
    return {
      error: Response.json(
        { error: 'This API has not been claimed yet — claim it before wiring up CI sync.' },
        { status: 409 },
      ),
    };
  }
  return { api };
}

function notConfigured(): Response {
  return Response.json(
    { error: 'CI sync is not configured — set SPOTCHECK_MASTER_KEY and redeploy' },
    { status: 503 },
  );
}

// Issues the CI sync token for an API. The token is derived, not stored (see
// ciSync.ts), so calling this twice without rotating returns the same value —
// which is what makes it safe to re-read after losing it, and why rotation has
// to be explicit.
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  if (!dbReady()) {
    return Response.json({ error: 'Persistence is not configured — connect Postgres and redeploy' }, { status: 503 });
  }
  if (!masterKeyReady()) return notConfigured();

  const { userId } = await auth();
  if (!userId) return Response.json({ error: 'Sign in required' }, { status: 401 });

  const rl = await getLimiter('ci-token', TOKEN_LIMIT).limit(userId);
  if (!rl.success) return tooMany(rl.reset);

  const { slug } = await ctx.params;
  const owned = await requireOwnership(slug, userId);
  if (owned.error) return owned.error;

  let body: { rotate?: unknown } = {};
  try {
    body = (await req.json()) as { rotate?: unknown };
  } catch {
    // An empty body is the common case (just read the current token).
  }

  const db = getDb();
  let version = owned.api.ciTokenVersion;
  if (body.rotate === true) {
    const [updated] = await db
      .update(apis)
      .set({ ciTokenVersion: sql`${apis.ciTokenVersion} + 1`, updatedAt: new Date() })
      .where(eq(apis.id, owned.api.id))
      .returning({ ciTokenVersion: apis.ciTokenVersion });
    version = updated.ciTokenVersion;
  }

  return Response.json({
    slug,
    token: ciTokenFor(owned.api.id, version),
    tokenVersion: version,
    rotated: body.rotate === true,
    usage: {
      secretName: 'SPOTCHECK_TOKEN',
      endpoint: '/api/ci/sync',
      note: 'Store this in your repository secrets. Rotate with {"rotate":true}, which immediately invalidates every previously issued token for this API.',
    },
  });
}
