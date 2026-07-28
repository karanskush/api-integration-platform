import { verifySignatureAppRouter } from '@upstash/qstash/nextjs';
import { and, eq } from 'drizzle-orm';
import { aiReady } from '@/lib/ask';
import { getDb } from '@/lib/db';
import { actions as actionsTable, analysisRuns, apis, clarifications, evidenceFacts } from '@/lib/db/schema';
import { clusterQuestions, consideredFieldsFor, type DocExcerpt, enrichRecord, reconcileOpenQuestions } from '@/lib/deepEnrich';
import {
  classifyQuestion,
  evidenceForQuestion,
  questionHandle,
  synthesizeMappings,
  triageQuestions,
} from '@/lib/clarify';
import { fieldMapFor } from '@/lib/fieldMap';
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

    // Operation name -> path, so questions about the same field on different
    // operations can be recognised as one question. Passed to reconcile too, so
    // the auto-clarification budget is spent per cluster rather than per site.
    const actionPathByName = new Map(record.actions.map((a) => [a.name, a.path]));

    const considered = consideredFieldsFor(record, record.actions);
    const autoQuestions = reconcileOpenQuestions(considered, result, actionPathByName);
    const allQuestions = clusterQuestions([...result.openQuestions, ...autoQuestions], actionPathByName);

    // Reported on the run rather than discarded. A triage pass that retired
    // nothing and a triage pass that was refused for cause look identical from
    // the outside otherwise, and the rejection reasons are how you find out the
    // model is producing quotes that do not verify.
    let triageDetail: Record<string, unknown> = {};

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

      // Classified here, deterministically, from the field's own shape and the
      // lineage we already have. Storing the answer space on the row is what
      // lets the completion page render a quiz without re-deriving anything, and
      // lets the answer route validate a choice against the exact options the
      // question was asked with.
      const classified = allQuestions.map((q) => ({ q, c: classifyQuestion(record, q) }));
      // Concrete questions first: someone who answers three quickly keeps going.
      classified.sort((a, b) => (a.c?.rank ?? 99) - (b.c?.rank ?? 99));

      // Two model passes, each strictly bounded and each degrading to the
      // pre-existing behaviour on any failure. Triage can only downgrade a
      // question to an assumption the owner still sees; synthesis can only
      // pre-fill candidate meanings for a code the spec never documented. Neither
      // can create, answer or delete a question.
      //
      // Skipped entirely on a partial reading of the API: an incomplete
      // enrichment pass is exactly when an inference drawn from it would be wrong.
      const enrichmentComplete = !result.truncated && result.chunksProcessed >= result.chunksTotal;
      const triage = aiReady()
        ? await triageQuestions({
            enrichmentComplete,
            candidates: classified.flatMap(({ q, c }) =>
              c && q.fieldPath
                ? [
                    {
                      id: questionHandle(q),
                      question: q.question,
                      tool: q.tool,
                      actionPath: actionPathByName.get(q.tool) ?? '',
                      fieldPath: q.fieldPath,
                      answerSpec: c.answerSpec,
                      envelopes: evidenceForQuestion(record, q, docExcerpts),
                    },
                  ]
                : [],
            ),
          })
        : { assumptions: [], rejections: [], considered: 0 };
      const assumedByHandle = new Map(triage.assumptions.map((a) => [a.id, a]));
      triageDetail = {
        triageConsidered: triage.considered,
        triageAssumed: triage.assumptions.length,
        ...(triage.skipped ? { triageSkipped: triage.skipped } : {}),
        ...(triage.rejections.length ? { triageRejections: triage.rejections.slice(0, 20) } : {}),
      };

      // The one archetype whose answer space cannot be enumerated from structure.
      const openValueQuestions = classified.filter(({ c }) => c?.archetype === 'undocumented_code_semantics');
      const synthesis =
        aiReady() && openValueQuestions.length
          ? await synthesizeMappings({
              candidates: openValueQuestions.flatMap(({ q }) => {
                const action = record.actions.find((a) => a.name === q.tool);
                const field = action && q.fieldPath ? fieldMapFor(action).request.find((f) => f.path === q.fieldPath) : undefined;
                return action && field && q.fieldPath
                  ? [
                      {
                        id: questionHandle(q),
                        question: q.question,
                        tool: q.tool,
                        actionPath: action.path,
                        fieldPath: q.fieldPath,
                        fieldType: field.type,
                        ...(field.description ? { fieldDescription: field.description } : {}),
                        envelopes: evidenceForQuestion(record, q, docExcerpts),
                      },
                    ]
                  : [];
              }),
            })
          : { suggestions: new Map(), rejections: [] };

      await db
        .insert(clarifications)
        .values(
          classified.map(({ q, c }) => {
            const handle = questionHandle(q);
            const assumed = assumedByHandle.get(handle);
            const suggestions = synthesis.suggestions.get(handle);
            return {
              apiId,
              specVersionId,
              actionId: idByName.get(q.tool) ?? null,
              fieldPath: q.fieldPath ?? null,
              kind: q.kind,
              question: q.question,
              options: q.options ?? null,
              groupKey: q.groupKey ?? null,
              appliesTo: q.appliesTo ?? null,
              ...(c
                ? {
                    archetype: c.archetype,
                    answerSpec: {
                      ...c.answerSpec,
                      why: c.why,
                      unlocks: c.unlocks,
                      ...(suggestions?.length ? { suggestions } : {}),
                    },
                  }
                : {}),
              // Downgraded, not removed. It still renders, with its quote and
              // source, and one click puts it back to pending. answerSource stays
              // 'llm' so the human-only CHECK keeps holding.
              ...(assumed
                ? {
                    status: 'assumed',
                    answerSource: 'llm',
                    assumedAnswer: assumed.answer,
                    assumedBasis: {
                      quote: assumed.quote,
                      sourceKind: assumed.sourceKind,
                      ...(assumed.sourceUrl ? { sourceUrl: assumed.sourceUrl } : {}),
                    },
                  }
                : {}),
            };
          }),
        )
        // A retried job re-derives the same groups. The partial unique index on
        // (spec_version_id, group_key) turns that into a no-op rather than a
        // duplicate set of questions or a failed run.
        .onConflictDoNothing();
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
          ...triageDetail,
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
