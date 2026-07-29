import { verifySignatureAppRouter } from '@upstash/qstash/nextjs';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { stringify as stringifyYaml } from 'yaml';
import { analysisAccessTokenFor } from '@/lib/analysisAccess';
import { buildArazzoDocument } from '@/lib/artifacts/arazzo';
import { buildEnrichedSpec, type AssumedAnswer, type HumanAnswer } from '@/lib/artifacts/enrichedSpec';
import { originForAnswer, type AnswerSpec } from '@/lib/clarify';
import { getDb } from '@/lib/db';
import { actions as actionsTable, analysisRuns, apis, clarifications, evidenceFacts, specVersions, users } from '@/lib/db/schema';
import { emailReady, sendAnalysisReadyEmail, sendClarificationNeededEmail } from '@/lib/email';
import { loadRecordForVersion } from '@/lib/persistentApi';
import { putArazzoArtifact, putEnrichedSpecArtifact } from '@/lib/specStore';
import { appOrigin } from '@/lib/origin';

export const maxDuration = 60;

const qstashReady = Boolean(process.env.QSTASH_CURRENT_SIGNING_KEY && process.env.QSTASH_NEXT_SIGNING_KEY);


// The last stage of the deep-analysis chain — and, unlike crawl/enrich, one
// that legitimately runs MORE THAN ONCE per spec version: once right after
// enrichment, and again every time the clarification-answer route resolves
// the last open question. So idempotency here isn't "has this stage ever
// succeeded" (crawl/enrich's model) but "does the CURRENT pending count match
// the last successful run's" — a QStash retry of the identical situation is a
// no-op, but a genuinely changed pending count (3 -> 0 after an answer) always
// re-runs.
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

  const pendingRows = await db
    .select({ id: clarifications.id })
    .from(clarifications)
    .where(
      and(eq(clarifications.apiId, apiId), eq(clarifications.specVersionId, specVersionId), eq(clarifications.status, 'pending')),
    );
  const pendingCount = pendingRows.length;
  // Reported in the run detail so a completed analysis records how much of it
  // stayed unknown, rather than reading as fully resolved.
  let unresolvedTotal = 0;

  const [lastRun] = await db
    .select({ status: analysisRuns.status, detail: analysisRuns.detail })
    .from(analysisRuns)
    .where(and(eq(analysisRuns.apiId, apiId), eq(analysisRuns.specVersionId, specVersionId), eq(analysisRuns.stage, 'finalize')))
    .orderBy(desc(analysisRuns.startedAt))
    .limit(1);
  const lastPending = (lastRun?.detail as { pendingCount?: number } | null)?.pendingCount;
  if (lastRun?.status === 'succeeded' && lastPending === pendingCount) {
    return Response.json({ ok: true, skipped: true });
  }

  const [run] = await db
    .insert(analysisRuns)
    .values({ apiId, specVersionId, stage: 'finalize', status: 'running' })
    .returning({ id: analysisRuns.id });

  try {
    const [api] = await db.select().from(apis).where(eq(apis.id, apiId)).limit(1);
    if (!api) throw new Error('API not found');

    let email: string | undefined;
    if (api.createdBy) {
      const [creator] = await db.select({ email: users.email }).from(users).where(eq(users.id, api.createdBy)).limit(1);
      email = creator?.email;
    }

    if (pendingCount > 0) {
      await db.update(apis).set({ analysisStatus: 'needs_input' }).where(eq(apis.id, apiId));
      if (email && emailReady()) {
        const token = analysisAccessTokenFor(apiId);
        const completeUrl = `${appOrigin()}/apis/${api.slug}/complete?token=${token}`;
        await sendClarificationNeededEmail(email, { apiName: api.name, completeUrl, questionCount: pendingCount });
      }
    } else {
      const record = await loadRecordForVersion(apiId, specVersionId);
      if (!record) throw new Error('Spec version not found');

      // Human-verified lookup is keyed by (action NAME, field path) —
      // clarifications.action_id is the actions table's row uuid, which is
      // NOT what record.actions[].id holds (that's the stable actionKey, see
      // persistentApi.ts's toAction), so resolving the name needs its own
      // lookup rather than matching against the record directly.
      const resolvedRows = await db
        .select({
          actionId: clarifications.actionId,
          fieldPath: clarifications.fieldPath,
          appliesTo: clarifications.appliesTo,
          answerSource: clarifications.answerSource,
          status: clarifications.status,
          answer: clarifications.answer,
          answerSpec: clarifications.answerSpec,
          assumedAnswer: clarifications.assumedAnswer,
          assumedBasis: clarifications.assumedBasis,
        })
        .from(clarifications)
        .where(
          and(
            eq(clarifications.apiId, apiId),
            eq(clarifications.specVersionId, specVersionId),
            inArray(clarifications.status, ['answered', 'skipped', 'assumed']),
          ),
        );
      // Only a human's answer may mark a field verified. The DB CHECK already
      // makes any other source unrepresentable while answered; splitting on it
      // here keeps the read side honest on its own terms too, and is what stops
      // an assumption from ever reaching the verified set.
      const answeredRows = resolvedRows.filter((r) => r.status === 'answered' && r.answerSource === 'human');
      const skippedRows = resolvedRows.filter((r) => r.status === 'skipped');
      const assumedRows = resolvedRows.filter((r) => r.status === 'assumed');
      const answeredActionIds = [...new Set(answeredRows.map((r) => r.actionId).filter((id): id is string => id !== null))];
      const nameById = answeredActionIds.length
        ? new Map(
            (await db.select({ id: actionsTable.id, name: actionsTable.name }).from(actionsTable).where(inArray(actionsTable.id, answeredActionIds))).map(
              (a) => [a.id, a.name],
            ),
          )
        : new Map<string, string>();
      // A clustered question was asked once and answered once, but covers every
      // site in applies_to — which stores the action NAME directly, so those
      // rows skip the action_id -> name round-trip entirely. Without this the
      // owner answers about petId and only one of the four operations that
      // actually asked gets marked.
      const sitesOf = (r: (typeof resolvedRows)[number]): string[] => {
        const sites = r.appliesTo as Array<{ tool: string; fieldPath: string }> | null;
        if (Array.isArray(sites) && sites.length) return sites.map((s) => `${s.tool} ${s.fieldPath}`);
        if (r.actionId && r.fieldPath && nameById.has(r.actionId)) return [`${nameById.get(r.actionId)} ${r.fieldPath}`];
        return [];
      };

      // The answer's meaning for the artifact, resolved against the exact option
      // set the question was asked with — never against whatever the client sent.
      const answers = new Map<string, HumanAnswer>();
      for (const r of answeredRows) {
        const spec = r.answerSpec as AnswerSpec | null;
        const chosen = typeof r.answer === 'string' ? r.answer : null;
        const origin = spec && chosen ? originForAnswer(spec, chosen) : null;
        for (const site of sitesOf(r)) answers.set(site, origin ? { origin } : {});
      }
      const unresolved = new Set(skippedRows.flatMap(sitesOf));

      // What triage concluded, resolved through the same option set a human
      // answer goes through, so a model can never introduce a meaning the
      // archetype did not define. Applied to the origin, never to the verified
      // marker — see enrichedSpec.ts.
      const assumptions = new Map<string, AssumedAnswer>();
      for (const r of assumedRows) {
        const spec = r.answerSpec as AnswerSpec | null;
        const chosen = typeof r.assumedAnswer === 'string' ? r.assumedAnswer : null;
        const basis = r.assumedBasis as { quote?: string; sourceKind?: string; sourceUrl?: string } | null;
        if (!basis?.quote) continue; // an assumption without its receipt is not usable
        const origin = spec && chosen ? originForAnswer(spec, chosen) : null;
        for (const site of sitesOf(r)) {
          assumptions.set(site, {
            ...(origin ? { origin } : {}),
            quote: basis.quote,
            sourceKind: basis.sourceKind ?? 'spec_field',
            ...(basis.sourceUrl ? { sourceUrl: basis.sourceUrl } : {}),
          });
        }
      }

      // Lineage edges the enrichment pass disagreed with. Withheld from the
      // artifact, kept in evidence_facts.
      const disputeRows = await db
        .select({ payload: evidenceFacts.payload })
        .from(evidenceFacts)
        .where(
          and(
            eq(evidenceFacts.apiId, apiId),
            eq(evidenceFacts.specVersionId, specVersionId),
            eq(evidenceFacts.kind, 'llm.lineage_dispute'),
          ),
        );
      const disputed = new Set(
        disputeRows.flatMap((row) => {
          const p = row.payload as { tool?: string; field?: string; producer?: string } | null;
          if (!p?.tool || !p.field || !p.producer) return [];
          // knownProducers renders as "tool.field (confidence)"; the artifact
          // keys on "tool field tool.field", so drop the confidence suffix.
          return [`${p.tool} ${p.field} ${p.producer.replace(/\s*\([^)]*\)\s*$/, '')}`];
        }),
      );

      const arazzoDoc = buildArazzoDocument(record, record.sourceUrl ?? `${appOrigin()}/${api.slug}`);
      const enrichedSpec = buildEnrichedSpec(record, { answers, assumptions, unresolved, disputed });

      const [arazzoResult, enrichedResult] = await Promise.all([
        putArazzoArtifact(specVersionId, stringifyYaml(arazzoDoc)),
        putEnrichedSpecArtifact(specVersionId, JSON.stringify(enrichedSpec, null, 2)),
      ]);

      await db
        .update(specVersions)
        .set({
          ...(arazzoResult ? { arazzoBlobRef: arazzoResult.blobRef } : {}),
          ...(enrichedResult ? { enrichedSpecBlobRef: enrichedResult.blobRef } : {}),
        })
        .where(eq(specVersions.id, specVersionId));

      await db.update(apis).set({ analysisStatus: 'complete' }).where(eq(apis.id, apiId));

      if (email && emailReady()) {
        await sendAnalysisReadyEmail(email, {
          apiName: api.name,
          pageUrl: `${appOrigin()}/${api.slug}`,
          unresolvedCount: unresolved.size,
        });
      }
      unresolvedTotal = unresolved.size;
    }

    await db
      .update(analysisRuns)
      .set({ status: 'succeeded', completedAt: new Date(), detail: { pendingCount, unresolvedCount: unresolvedTotal } })
      .where(eq(analysisRuns.id, run.id));
  } catch (err) {
    await db
      .update(analysisRuns)
      .set({ status: 'failed', completedAt: new Date(), error: err instanceof Error ? err.message : 'unknown error' })
      .where(eq(analysisRuns.id, run.id));
    await db.update(apis).set({ analysisStatus: 'failed' }).where(eq(apis.id, apiId));
  }

  return Response.json({ ok: true });
}

export const POST = qstashReady
  ? verifySignatureAppRouter(handler)
  : async () => Response.json({ error: 'Job queue is not configured' }, { status: 503 });
