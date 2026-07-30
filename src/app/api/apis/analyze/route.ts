import { auth, currentUser } from '@clerk/nextjs/server';
import { eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { dbReady, getDb } from '@/lib/db';
import { analysisRuns, apis } from '@/lib/db/schema';
import { discoverDocSeeds } from '@/lib/docsCrawler';
import { findOrgApiForSpec, specContentHash } from '@/lib/existingApi';
import { ImportInputError, runImport } from '@/lib/importer';
import { CurlParseError } from '@/lib/importer/curl';
import { DetectError } from '@/lib/importer/detect';
import { ParseError } from '@/lib/importer/openapi';
import { PostmanConvertError } from '@/lib/importer/postman';
import { getOrCreateOrgForUser } from '@/lib/org';
import { persistApi, reimportApi } from '@/lib/persist';
import { limitsFor } from '@/lib/plans';
import { publishJob, queueReady } from '@/lib/queue';
import { getLimiter, tooMany } from '@/lib/ratelimit';
import { SsrfError, UpstreamError } from '@/lib/ssrf';
import { appOrigin } from '@/lib/origin';

export const maxDuration = 60;

// Deep analyses are expensive (an LLM enrichment pass plus, when doc URLs are
// given, a bounded crawl) — capped far below the plain-parse /api/import
// limiter.
const ANALYZE_LIMIT = { limit: 10, windowSec: 86_400 };
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_DOC_URLS = 5;


// The authenticated, fully-async entry point for the deep-analysis pipeline —
// distinct from /api/import (anonymous, ephemeral, instant preview, left
// untouched). No anonymous hop here: the caller is signed in from the first
// request, so this persists directly rather than parking in Redis pending a
// later claim. The fast parse + persist below still happen synchronously
// (same <10s budget /api/import already uses); everything slow (crawling the
// provider's docs, the LLM enrichment pass, any human clarification) runs in
// the background via QStash, and this response is deliberately data-free —
// no score, no fields, no page — until that finishes.
export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: 'Sign in required' }, { status: 401 });

  if (!dbReady()) {
    return Response.json({ error: 'Persistence is not configured — connect Postgres and redeploy' }, { status: 503 });
  }
  if (!queueReady()) {
    return Response.json({ error: 'Background processing is not configured — connect QStash and redeploy' }, { status: 503 });
  }

  const rl = await getLimiter('analyze-submit', ANALYZE_LIMIT).limit(userId);
  if (!rl.success) return tooMany(rl.reset);

  let body: { url?: unknown; text?: unknown; docUrls?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const url = typeof body.url === 'string' ? body.url.trim() : undefined;
  const text = typeof body.text === 'string' ? body.text : undefined;
  if (text && Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
    return Response.json({ error: 'Pasted spec is too large (max 1MB)' }, { status: 413 });
  }
  const docUrls = Array.isArray(body.docUrls)
    ? body.docUrls.filter((u): u is string => typeof u === 'string' && u.trim().length > 0).slice(0, MAX_DOC_URLS)
    : [];

  let imported: Awaited<ReturnType<typeof runImport>>;
  try {
    imported = await runImport({ url: url || undefined, text: text || undefined });
  } catch (err) {
    if (err instanceof SsrfError) {
      return Response.json({ error: `URL not allowed: ${err.message}` }, { status: 400 });
    }
    if (err instanceof UpstreamError) {
      return Response.json({ error: err.message }, { status: 502 });
    }
    if (
      err instanceof ImportInputError ||
      err instanceof DetectError ||
      err instanceof CurlParseError ||
      err instanceof PostmanConvertError ||
      err instanceof ParseError
    ) {
      const status = err instanceof ImportInputError ? 400 : 422;
      return Response.json({ error: err.message }, { status });
    }
    console.error('[analyze] import failed unexpectedly');
    return Response.json({ error: 'Import failed unexpectedly' }, { status: 500 });
  }
  const { record, rawText } = imported;

  const user = await currentUser();
  const email = user?.primaryEmailAddress?.emailAddress ?? user?.emailAddresses[0]?.emailAddress;
  if (!email) return Response.json({ error: 'Your account has no email address on file' }, { status: 400 });

  const db = getDb();
  const { user: dbUser, org } = await getOrCreateOrgForUser(db, userId, email);

  // Already analysed this spec? Then don't analyse it again. Deep analysis is
  // the expensive path, and re-running it for known bytes would both burn an
  // LLM pass and fork a duplicate page. See existingApi.ts.
  const contentHash = specContentHash(rawText);
  const existing = await findOrgApiForSpec(db, org.id, { contentHash, sourceUrl: record.sourceUrl });
  if (existing) {
    const docSeeds = discoverDocSeeds(record.externalDocsUrl, docUrls);

    // Identical bytes, and the analysis either finished or is still running:
    // there is nothing new to learn, so spend nothing and send them to the
    // page they already have. A failed run is the one case where the same
    // bytes deserve another attempt.
    if (existing.isCurrentSpec && existing.analysisStatus !== 'failed') {
      return Response.json({
        id: existing.apiId,
        slug: existing.slug,
        status: existing.analysisStatus,
        reused: true,
        pageUrl: `${appOrigin(req)}/${existing.slug}`,
        note:
          existing.analysisStatus === 'complete'
            ? 'This spec is unchanged since we last analysed it, so the existing analysis stands.'
            : 'The analysis for this spec is already running.',
      });
    }

    // The spec moved on (or the last attempt failed): version the API we
    // already have rather than forking a second page, and re-run the deep
    // pass over the change.
    const revision = await reimportApi(db, { apiId: existing.apiId, record, rawText });
    await db
      .update(apis)
      .set({ analysisStatus: 'queued', updatedAt: new Date() })
      .where(eq(apis.id, existing.apiId));
    await db.insert(analysisRuns).values({
      apiId: existing.apiId,
      specVersionId: revision.specVersionId,
      stage: 'parse',
      status: 'succeeded',
      completedAt: new Date(),
    });
    await publishJob('/api/jobs/analyze-crawl', {
      apiId: existing.apiId,
      specVersionId: revision.specVersionId,
      docSeeds,
    });

    // The page is ISR — it must show "in progress" now, not in an hour.
    revalidatePath(`/${existing.slug}`);

    return Response.json({
      id: existing.apiId,
      slug: existing.slug,
      status: 'queued',
      reused: true,
      revision: revision.status,
      pageUrl: `${appOrigin(req)}/${existing.slug}`,
      note: 'This spec changed since we last analysed it — re-analysing the new revision.',
    });
  }

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

  const result = await persistApi(db, {
    orgId: org.id,
    createdBy: dbUser.id,
    record,
    rawText,
    analysisStatus: 'queued',
  });

  // Observability for the stage that just ran synchronously — the QStash
  // chain's own stages (crawl/enrich/finalize) each write their own row the
  // same way, so analysis_runs has one entry per stage from the start.
  await db.insert(analysisRuns).values({
    apiId: result.apiId,
    specVersionId: result.specVersionId,
    stage: 'parse',
    status: 'succeeded',
    completedAt: new Date(),
  });

  // Resolved once, here, while `record` is still in memory — the job only
  // ever receives the final seed list, never the record itself.
  const docSeeds = discoverDocSeeds(record.externalDocsUrl, docUrls);

  await publishJob('/api/jobs/analyze-crawl', {
    apiId: result.apiId,
    specVersionId: result.specVersionId,
    docSeeds,
  });

  return Response.json({
    id: result.apiId,
    slug: result.slug,
    status: 'queued',
    pageUrl: `${appOrigin(req)}/${result.slug}`,
  });
}
