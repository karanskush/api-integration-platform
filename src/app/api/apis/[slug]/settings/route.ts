import { auth } from '@clerk/nextjs/server';
import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { ownershipError, resolveApiOwnership } from '@/lib/apiOwnership';
import { dbReady, getDb } from '@/lib/db';
import { apis } from '@/lib/db/schema';
import { can } from '@/lib/plans';
import { getLimiter, tooMany } from '@/lib/ratelimit';

export const maxDuration = 30;

const SETTINGS_LIMIT = { limit: 30, windowSec: 600 };
const VISIBILITIES = ['public', 'private'] as const;

// Owner-editable settings for a claimed API. Today: visibility, and which
// actions are exposed over MCP.
//
// Both are security-relevant, so both are here rather than inferred: visibility
// decides who can see the page at all, and enabledForMcp decides what an agent
// can execute. Flipping to private purges the ISR page and badge immediately —
// without that, the public version would keep being served from cache for up to
// an hour after the owner made it private, which is the whole point of the
// setting.
export async function PATCH(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  if (!dbReady()) {
    return Response.json({ error: 'Persistence is not configured — connect Postgres and redeploy' }, { status: 503 });
  }

  const { userId } = await auth();
  if (!userId) return Response.json({ error: 'Sign in required' }, { status: 401 });

  const rl = await getLimiter('api-settings', SETTINGS_LIMIT).limit(userId);
  if (!rl.success) return tooMany(rl.reset);

  const { slug } = await ctx.params;
  const db = getDb();
  const owned = await resolveApiOwnership(db, slug, userId);
  if (!owned.ok) {
    return ownershipError(owned.reason, owned.reason === 'unclaimed' ? 'Claim this API before changing its settings.' : undefined);
  }

  let body: { visibility?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (body.visibility === undefined) {
    return Response.json({ error: 'Nothing to update — supply visibility.' }, { status: 400 });
  }

  const visibility = typeof body.visibility === 'string' ? body.visibility.trim().toLowerCase() : '';
  if (!VISIBILITIES.includes(visibility as (typeof VISIBILITIES)[number])) {
    return Response.json({ error: `visibility must be one of: ${VISIBILITIES.join(', ')}` }, { status: 400 });
  }

  if (visibility === 'private' && !can(owned.api.orgPlan, 'privateApis')) {
    return Response.json(
      { error: 'Private APIs are a Team plan feature — upgrade to hide a page from the public web.' },
      { status: 403 },
    );
  }

  if (visibility === owned.api.visibility) {
    return Response.json({ slug: owned.api.slug, visibility, changed: false });
  }

  await db.update(apis).set({ visibility, updatedAt: new Date() }).where(eq(apis.id, owned.api.id));

  // Going private must take effect now, not when the cache happens to expire.
  revalidatePath(`/${owned.api.slug}`);
  revalidatePath(`/badge/${owned.api.slug}`);

  return Response.json({
    slug: owned.api.slug,
    visibility,
    changed: true,
    note:
      visibility === 'private'
        ? `This page, its badge, its playground, and its MCP server now return 404 to anyone outside your org. Agents need the org access token (POST /api/orgs/mcp-token) to reach the MCP server.`
        : 'This page is public again.',
  });
}
