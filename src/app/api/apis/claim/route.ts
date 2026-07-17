import { auth, currentUser } from '@clerk/nextjs/server';
import { eq, sql } from 'drizzle-orm';
import { dbReady, getDb } from '@/lib/db';
import { apis } from '@/lib/db/schema';
import { isValidId } from '@/lib/ids';
import { kv, storageReady } from '@/lib/kv';
import { getOrCreateOrgForUser } from '@/lib/org';
import { persistApi } from '@/lib/persist';
import { limitsFor } from '@/lib/plans';

export const maxDuration = 60;

function appOrigin(req: Request): string {
  return process.env.PUBLIC_APP_ORIGIN?.replace(/\/$/, '') || new URL(req.url).origin;
}

// Claims a still-live anonymous import into the signed-in user's account —
// same persistApi() transaction a direct authenticated persist would use
// (see persist.ts), so claimed and directly-persisted APIs get identical
// guarantees (content hash, evidence facts, score preview).
export async function POST(req: Request) {
  if (!dbReady()) {
    return Response.json({ error: 'Persistence is not configured — connect Postgres and redeploy' }, { status: 503 });
  }
  if (!storageReady()) {
    return Response.json({ error: 'Storage not configured — connect Upstash Redis and redeploy' }, { status: 503 });
  }

  const { userId } = await auth();
  if (!userId) return Response.json({ error: 'Sign in required' }, { status: 401 });

  let body: { ephemeralId?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const ephemeralId = typeof body.ephemeralId === 'string' ? body.ephemeralId : '';
  if (!isValidId(ephemeralId)) return Response.json({ error: 'Unknown import' }, { status: 404 });

  const record = await kv().getImport(ephemeralId);
  if (!record || record.expiresAt <= Date.now()) {
    return Response.json({ error: 'This import has expired — re-import the spec first' }, { status: 404 });
  }
  const rawText = await kv().getRawSpec(ephemeralId);
  if (rawText == null) {
    return Response.json({ error: 'Original spec text is no longer available for this import' }, { status: 404 });
  }

  const user = await currentUser();
  const email = user?.primaryEmailAddress?.emailAddress ?? user?.emailAddresses[0]?.emailAddress;
  if (!email) return Response.json({ error: 'Your account has no email address on file' }, { status: 400 });

  const db = getDb();
  const { user: dbUser, org } = await getOrCreateOrgForUser(db, userId, email);

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(apis)
    .where(eq(apis.orgId, org.id));
  const limit = limitsFor(org.plan).maxPersistentApis;
  if (count >= limit) {
    return Response.json(
      { error: `Your ${org.plan} plan allows up to ${limit} persistent API${limit === 1 ? '' : 's'} — upgrade to save more.` },
      { status: 403 },
    );
  }

  const result = await persistApi(db, { orgId: org.id, createdBy: dbUser.id, record, rawText });

  const origin = appOrigin(req);
  return Response.json({
    apiId: result.apiId,
    slug: result.slug,
    pageUrl: `${origin}/${result.slug}`,
    mcpUrl: `${origin}/mcp/${result.slug}`,
  });
}
