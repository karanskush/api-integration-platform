import { verifySignatureAppRouter } from '@upstash/qstash/nextjs';
import { and, eq } from 'drizzle-orm';
import { asData } from '@/lib/advisor/types';
import { getDb } from '@/lib/db';
import { analysisRuns, apis, evidenceFacts } from '@/lib/db/schema';
import { crawlDocs } from '@/lib/docsCrawler';
import { publishJob } from '@/lib/queue';

export const maxDuration = 120;

const qstashReady = Boolean(process.env.QSTASH_CURRENT_SIGNING_KEY && process.env.QSTASH_NEXT_SIGNING_KEY);

const MAX_EXCERPT_CHARS = 4000;

// Stage 1 of the deep-analysis chain: crawl whatever doc seeds were resolved
// at submission time (see /api/apis/analyze), store each page as a
// llm.doc_grounding evidence fact, then hand off to analyze-enrich. A doc
// crawl that fails entirely (no seeds, or every fetch blocked/unreachable)
// is not fatal — the enrichment pass still has the spec itself to work from
// — so this always chains forward rather than dead-ending the pipeline.
async function handler(req: Request) {
  let body: { apiId?: unknown; specVersionId?: unknown; docSeeds?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const apiId = typeof body.apiId === 'string' ? body.apiId : '';
  const specVersionId = typeof body.specVersionId === 'string' ? body.specVersionId : '';
  const docSeeds = Array.isArray(body.docSeeds) ? body.docSeeds.filter((s): s is string => typeof s === 'string') : [];
  if (!apiId || !specVersionId) return Response.json({ error: 'Missing apiId or specVersionId' }, { status: 400 });

  const db = getDb();

  // Idempotency: QStash retries at least once, so a retry after this stage
  // already succeeded must be a no-op rather than a double write.
  const existing = await db
    .select({ status: analysisRuns.status })
    .from(analysisRuns)
    .where(
      and(eq(analysisRuns.apiId, apiId), eq(analysisRuns.specVersionId, specVersionId), eq(analysisRuns.stage, 'crawl')),
    )
    .limit(1);
  if (existing.length && existing[0].status === 'succeeded') {
    await publishJob('/api/jobs/analyze-enrich', { apiId, specVersionId });
    return Response.json({ ok: true, skipped: true });
  }

  await db.update(apis).set({ analysisStatus: 'crawling' }).where(eq(apis.id, apiId));
  const [run] = await db
    .insert(analysisRuns)
    .values({ apiId, specVersionId, stage: 'crawl', status: 'running' })
    .returning({ id: analysisRuns.id });

  try {
    const result = docSeeds.length ? await crawlDocs(docSeeds) : { pages: [], truncated: false };

    if (result.pages.length) {
      await db.insert(evidenceFacts).values(
        result.pages.map((page) => ({
          apiId,
          specVersionId,
          kind: 'llm.doc_grounding' as const,
          source: 'llm',
          payload: {
            url: page.url,
            ...(page.title ? { title: asData(page.title, 200) } : {}),
            excerpt: asData(page.text, MAX_EXCERPT_CHARS),
          },
        })),
      );
    }

    await db
      .update(analysisRuns)
      .set({
        status: 'succeeded',
        completedAt: new Date(),
        detail: { seeds: docSeeds.length, pagesCrawled: result.pages.length, truncated: result.truncated },
      })
      .where(eq(analysisRuns.id, run.id));
  } catch (err) {
    await db
      .update(analysisRuns)
      .set({ status: 'failed', completedAt: new Date(), error: err instanceof Error ? err.message : 'unknown error' })
      .where(eq(analysisRuns.id, run.id));
    // Fall through to enrichment anyway — doc grounding is optional context,
    // never a hard dependency of the pipeline.
  }

  await publishJob('/api/jobs/analyze-enrich', { apiId, specVersionId });
  return Response.json({ ok: true });
}

export const POST = qstashReady
  ? verifySignatureAppRouter(handler)
  : async () => Response.json({ error: 'Job queue is not configured' }, { status: 503 });
