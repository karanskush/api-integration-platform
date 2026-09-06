import { auth } from '@clerk/nextjs/server';
import { SEVERITIES, type Severity } from '@/lib/changes/diff';
import { changeSummary, listChanges, resolveSince } from '@/lib/changes/query';
import { dbReady, getDb } from '@/lib/db';
import { clientIp } from '@/lib/ip';
import { getLimiter, tooMany } from '@/lib/ratelimit';
import { apiVisibility, isOrgMember } from '@/lib/visibility';

export const maxDuration = 30;

const CHANGES_LIMIT = { limit: 120, windowSec: 60 };
const MAX_LIMIT = 500;

const clerkReady = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

// The change ledger as JSON. Public for a public API — this is the feed a
// consumer's CI polls to find out whether the provider moved under them, and
// requiring an account to ask "did this API change" would defeat the point.
//
// `since` accepts an ISO timestamp or a spec-version hash prefix, so a caller
// can ask "what changed since the version I integrated against" without having
// recorded when that was.
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  if (!dbReady()) {
    return Response.json({ error: 'Persistence is not configured — connect Postgres and redeploy' }, { status: 503 });
  }

  const rl = await getLimiter('changes', CHANGES_LIMIT).limit(clientIp(req));
  if (!rl.success) return tooMany(rl.reset);

  const { slug } = await ctx.params;
  const visibility = await apiVisibility(slug);
  const notFound = () => Response.json({ error: 'Unknown API' }, { status: 404 });
  if (!visibility.exists || !visibility.apiId) return notFound();

  // Private stays 404 rather than 403 for a non-member, so the response never
  // confirms that the slug exists (visibility.ts).
  if (visibility.private) {
    const { userId } = clerkReady ? await auth() : { userId: null };
    if (!visibility.orgId || !(await isOrgMember(userId, visibility.orgId))) return notFound();
  }

  const params = new URL(req.url).searchParams;

  const rawSeverity = params.get('severity');
  if (rawSeverity && !(SEVERITIES as readonly string[]).includes(rawSeverity)) {
    return Response.json({ error: `severity must be one of: ${SEVERITIES.join(', ')}` }, { status: 400 });
  }

  const rawLimit = Number(params.get('limit'));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(MAX_LIMIT, Math.floor(rawLimit)) : undefined;

  const db = getDb();
  const rawSince = params.get('since');
  let since: Date | undefined;
  if (rawSince) {
    const resolved = await resolveSince(db, visibility.apiId, rawSince);
    if (!resolved) {
      return Response.json(
        { error: 'since must be an ISO timestamp or a known spec-version content-hash prefix' },
        { status: 400 },
      );
    }
    since = resolved;
  }

  const [changes, summary] = await Promise.all([
    listChanges(db, visibility.apiId, { limit, since, severity: (rawSeverity as Severity | null) ?? undefined }),
    changeSummary(db, visibility.apiId),
  ]);

  return Response.json(
    {
      slug,
      currentSpecVersion: summary.currentVersionHash?.slice(0, 12) ?? null,
      lastCheckedAt: summary.lastCheckedAt,
      lastChangeAt: summary.lastChangeAt,
      changes30d: summary.counts30d,
      ...(since ? { since: since.toISOString() } : {}),
      count: changes.length,
      changes: changes.map((c) => ({
        observedAt: c.observedAt,
        kind: c.kind,
        severity: c.severity,
        source: c.source,
        tool: c.tool,
        method: c.method,
        path: c.path,
        fieldPath: c.fieldPath,
        location: c.location,
        summary: c.summary,
        detail: c.detail,
        specVersion: c.toContentHash?.slice(0, 12) ?? null,
      })),
    },
    {
      // Never shared-cacheable, public API or not. This route has no
      // `revalidate`, so revalidatePath() cannot purge it and purgeApiSurfaces()
      // cannot list it — a copy cached while the API was public would keep
      // serving the whole ledger for its TTL after the owner made it private.
      // The endpoint is an indexed read behind a per-IP rate limit, and its
      // entire value is freshness, so there is nothing to gain by caching it.
      headers: { 'Cache-Control': 'no-store' },
    },
  );
}
