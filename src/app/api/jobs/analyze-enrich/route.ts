import { verifySignatureAppRouter } from '@upstash/qstash/nextjs';
import { and, eq } from 'drizzle-orm';
import { aiReady } from '@/lib/ask';
import { getDb } from '@/lib/db';
import { actions as actionsTable, analysisRuns, apis, clarifications, evidenceFacts } from '@/lib/db/schema';
import { consideredFieldsFor, type DocExcerpt, enrichRecord, reconcileOpenQuestions } from '@/lib/deepEnrich';
import { loadRecordForVersion } from '@/lib/persistentApi';
import { publishJob } from '@/lib/queue';

export const maxDuration = 300;

const qstashReady = Boolean(process.env.QSTASH_CURRENT_SIGNING_KEY && process.env.QSTASH_NEXT_SIGNING_KEY);

// Stage 2 of the deep-analysis chain: the LLM semantic pass (deepEnrich.ts)
// plus the clarification-ledger writes it feeds. Runs after analyze-crawl,
// hands off to analyze-finalize regardless of outcome — a missing AI Gateway
// key (aiReady() false) or a fully-failed enrichment pass just means the
// pipeline falls back to heuristic-only facts, not a dead-ended import.
async function handler(req: Request) {
  let body: { apiId?: unknown; specVersionId?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const apiId = typeof body.apiId === 'string' ? body.apiId : '';
  const specVersionId = typeof body.specVersionId === 'string' ? body.specVersionId : '';
  if (!apiId || !specVersionId) return Response.json({ error: 'Missing apiId or specVersionId' }, { status: 400 });

  const db = getDb();

  const existing = await db
    .select({ status: analysisRuns.status })
    .from(analysisRuns)
    .where(
      and(eq(analysisRuns.apiId, apiId), eq(analysisRuns.specVersionId, specVersionId), eq(analysisRuns.stage, 'enrich')),
    )
    .limit(1);
  if (existing.length && existing[0].status === 'succeeded') {
    await publishJob('/api/jobs/analyze-finalize', { apiId, specVersionId });
    return Response.json({ ok: true, skipped: true });
  }

  await db.update(apis).set({ analysisStatus: 'enriching' }).where(eq(apis.id, apiId));
  const [run] = await db
    .insert(analysisRuns)
    .values({ apiId, specVersionId, stage: 'enrich', status: 'running' })
    .returning({ id: analysisRuns.id });

  try {
    const record = await loadRecordForVersion(apiId, specVersionId);
    if (!record) throw new Error('Spec version not found');

    const docRows = await db
      .select({ payload: evidenceFacts.payload })
      .from(evidenceFacts)
      .where(
        and(
          eq(evidenceFacts.apiId, apiId),
          eq(evidenceFacts.specVersionId, specVersionId),
          eq(evidenceFacts.kind, 'llm.doc_grounding'),
        ),
      );
    const docExcerpts: DocExcerpt[] = docRows.map((r) => r.payload as unknown as DocExcerpt);

    const result = aiReady()
      ? await enrichRecord({ record, docExcerpts })
      : { fields: [], openQuestions: [], chunksProcessed: 0, chunksTotal: 0, truncated: false };

    const considered = consideredFieldsFor(record, record.actions);
    const autoQuestions = reconcileOpenQuestions(considered, result);
    const allQuestions = [...result.openQuestions, ...autoQuestions];

    if (result.fields.length) {
      await db.insert(evidenceFacts).values(
        result.fields.map((f) => ({
          apiId,
          specVersionId,
          kind: 'llm.field_semantics' as const,
          source: 'llm',
          payload: {
            tool: f.tool,
            field: f.field,
            semanticMeaning: f.semanticMeaning,
            ...(f.businessConstraint ? { businessConstraint: f.businessConstraint } : {}),
            ...(f.confidenceOverride ? { confidenceOverride: f.confidenceOverride } : {}),
            sourcedFrom: f.sourcedFrom,
          },
        })),
      );
    }

    // Recorded as evidence, never as a clarification: a disputed producer is a
    // claim about our own heuristics, which the API's owner cannot adjudicate.
    // confidence 0.5 because it is one model's read against a structural signal
    // — enough to downgrade the edge at the artifact boundary, not enough to
    // erase it from the record.
    if (result.lineageDisputes?.length) {
      await db.insert(evidenceFacts).values(
        result.lineageDisputes.map((d) => ({
          apiId,
          specVersionId,
          kind: 'llm.lineage_dispute' as const,
          source: 'llm',
          confidence: 0.5,
          payload: { tool: d.tool, field: d.field, producer: d.producer, reason: d.reason },
        })),
      );
    }

    if (allQuestions.length) {
      // actionId is a nice-to-have FK for the completion UI to link straight
      // to an operation — resolved by name since that's what the enrichment
      // pass and the heuristics both key on, never by the DB row id they
      // never see.
      const actionRows = await db
        .select({ id: actionsTable.id, name: actionsTable.name })
        .from(actionsTable)
        .where(eq(actionsTable.specVersionId, specVersionId));
      const idByName = new Map(actionRows.map((a) => [a.name, a.id]));

      await db.insert(clarifications).values(
        allQuestions.map((q) => ({
          apiId,
          specVersionId,
          actionId: idByName.get(q.tool) ?? null,
          fieldPath: q.fieldPath ?? null,
          kind: q.kind,
          question: q.question,
          options: q.options ?? null,
        })),
      );
    }

    await db
      .update(analysisRuns)
      .set({
        status: 'succeeded',
        completedAt: new Date(),
        detail: {
          chunksProcessed: result.chunksProcessed,
          chunksTotal: result.chunksTotal,
          truncated: result.truncated,
          fieldsFound: result.fields.length,
          questionsRaised: allQuestions.length,
          aiConfigured: aiReady(),
        },
      })
      .where(eq(analysisRuns.id, run.id));
  } catch (err) {
    await db
      .update(analysisRuns)
      .set({ status: 'failed', completedAt: new Date(), error: err instanceof Error ? err.message : 'unknown error' })
      .where(eq(analysisRuns.id, run.id));
    // Fall through to finalize anyway — heuristic-only facts (already
    // persisted synchronously at submission time) are still a usable result.
  }

  await publishJob('/api/jobs/analyze-finalize', { apiId, specVersionId });
  return Response.json({ ok: true });
}

export const POST = qstashReady
  ? verifySignatureAppRouter(handler)
  : async () => Response.json({ error: 'Job queue is not configured' }, { status: 503 });
