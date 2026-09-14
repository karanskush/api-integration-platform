import { auth } from '@clerk/nextjs/server';
import { apis, specVersions } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';
import { dbReady, getDb } from '@/lib/db';
import { clientIp } from '@/lib/ip';
import { getLimiter, tooMany } from '@/lib/ratelimit';
import { getArtifactText } from '@/lib/specStore';
import { apiVisibility, isOrgMember } from '@/lib/visibility';

export const maxDuration = 30;

const ARTIFACT_LIMIT = { limit: 60, windowSec: 60 };

const clerkReady = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

// The two artifacts the deep-analysis pipeline has always produced and nobody
// could reach.
//
// analyze-finalize builds an Arazzo 1.0.1 workflow document and an enriched
// OpenAPI carrying x-docentapi-* provenance, uploads both to Blob and records
// the pointers on spec_versions — and getArtifactText() had no call sites
// outside its own test. Two complete, standards-shaped knowledge products,
// generated on every analysis and invisible.
//
// Served as files rather than through an MCP tool on purpose: the whole value
// of emitting Arazzo is that tools which are not this server can consume it —
// Redocly, Speakeasy, Specmatic, Bruno. Agents get the same workflows live via
// docentapi_get_workflows, which rebuilds them from the record and so can never
// serve a superseded version.
const KINDS = {
  arazzo: {
    column: 'arazzoBlobRef',
    contentType: 'application/yaml; charset=utf-8',
    filename: 'arazzo.yaml',
  },
  enriched: {
    column: 'enrichedSpecBlobRef',
    contentType: 'application/json; charset=utf-8',
    filename: 'openapi.enriched.json',
  },
} as const;

type Kind = keyof typeof KINDS;

export async function GET(req: Request, ctx: { params: Promise<{ slug: string; kind: string }> }) {
  if (!dbReady()) {
    return Response.json({ error: 'Persistence is not configured — connect Postgres and redeploy' }, { status: 503 });
  }

  const rl = await getLimiter('artifacts', ARTIFACT_LIMIT).limit(clientIp(req));
  if (!rl.success) return tooMany(rl.reset);

  const { slug, kind } = await ctx.params;
  if (!(kind in KINDS)) {
    return Response.json({ error: `kind must be one of: ${Object.keys(KINDS).join(', ')}` }, { status: 400 });
  }
  const spec = KINDS[kind as Kind];

  const visibility = await apiVisibility(slug);
  const notFound = () => Response.json({ error: 'Unknown API' }, { status: 404 });
  if (!visibility.exists || !visibility.apiId) return notFound();

  // Private stays 404 rather than 403 for a non-member, so the response never
  // confirms the slug exists (visibility.ts).
  if (visibility.private) {
    const { userId } = clerkReady ? await auth() : { userId: null };
    if (!visibility.orgId || !(await isOrgMember(userId, visibility.orgId))) return notFound();
  }

  const db = getDb();
  const [row] = await db
    .select({
      arazzoBlobRef: specVersions.arazzoBlobRef,
      enrichedSpecBlobRef: specVersions.enrichedSpecBlobRef,
      contentHash: specVersions.contentHash,
    })
    .from(apis)
    .innerJoin(specVersions, eq(specVersions.id, apis.currentSpecVersionId))
    .where(and(eq(apis.slug, slug)))
    .limit(1);

  const blobRef = row?.[spec.column];
  if (!blobRef) {
    // Deliberately distinct from a 404 on the API itself: the API exists, the
    // artifact simply has not been produced. analyze-finalize only writes these
    // once deep analysis completes with no open clarifications, so "not yet"
    // is a normal state and should read as one.
    return Response.json(
      {
        error: 'No such artifact for this API yet',
        detail:
          'Artifacts are produced when deep analysis completes with no open clarifications. Run an analysis, or answer the outstanding questions.',
      },
      { status: 404 },
    );
  }

  const text = await getArtifactText(blobRef);
  if (text === null) return Response.json({ error: 'Artifact could not be read' }, { status: 502 });

  return new Response(text, {
    headers: {
      'content-type': spec.contentType,
      'content-disposition': `inline; filename="${slug}.${spec.filename}"`,
      // Keyed to the spec version the artifact was built from, so a consumer
      // caching by ETag re-fetches exactly when the contract moves.
      etag: `"${row.contentHash}-${kind}"`,
      // Not ISR-cached: this reads Blob per request and, unlike the badge, is
      // not in purge.ts's surface list. no-store keeps it from going stale
      // behind a purge that would never reach it — same reasoning as the
      // changes JSON route.
      'cache-control': 'no-store',
    },
  });
}
