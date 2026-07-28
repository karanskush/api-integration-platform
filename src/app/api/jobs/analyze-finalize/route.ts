import { verifySignatureAppRouter } from '@upstash/qstash/nextjs';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { stringify as stringifyYaml } from 'yaml';
import { analysisAccessTokenFor } from '@/lib/analysisAccess';
import { buildArazzoDocument } from '@/lib/artifacts/arazzo';
import { buildEnrichedSpec } from '@/lib/artifacts/enrichedSpec';
import { getDb } from '@/lib/db';
import { actions as actionsTable, analysisRuns, apis, clarifications, specVersions, users } from '@/lib/db/schema';
import { emailReady, sendAnalysisReadyEmail, sendClarificationNeededEmail } from '@/lib/email';
import { loadRecordForVersion } from '@/lib/persistentApi';
import { putArazzoArtifact, putEnrichedSpecArtifact } from '@/lib/specStore';

export const maxDuration = 60;

const qstashReady = Boolean(process.env.QSTASH_CURRENT_SIGNING_KEY && process.env.QSTASH_NEXT_SIGNING_KEY);

function appOrigin(): string {
  return process.env.PUBLIC_APP_ORIGIN?.replace(/\/$/, '') || 'http://localhost:3000';
}

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
      const answeredRows = await db
        .select({
          actionId: clarifications.actionId,
          fieldPath: clarifications.fieldPath,
          appliesTo: clarifications.appliesTo,
        })
        .from(clarifications)
        .where(
          and(
            eq(clarifications.apiId, apiId),
            eq(clarifications.specVersionId, specVersionId),
            eq(clarifications.status, 'answered'),
            // Only a human's answer may mark a field verified. The DB CHECK
            // already makes any other source unrepresentable while answered;
            // this keeps the read side honest on its own terms too.
            eq(clarifications.answerSource, 'human'),
          ),
        );
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
      const humanVerifiedFields = new Set(
        answeredRows.flatMap((r) => {
          const sites = r.appliesTo as Array<{ tool: string; fieldPath: string }> | null;
          if (Array.isArray(sites) && sites.length) return sites.map((s) => `${s.tool} ${s.fieldPath}`);
          if (r.actionId && r.fieldPath && nameById.has(r.actionId)) return [`${nameById.get(r.actionId)} ${r.fieldPath}`];
          return [];
        }),
      );

      const arazzoDoc = buildArazzoDocument(record, record.sourceUrl ?? `${appOrigin()}/${api.slug}`);
      const enrichedSpec = buildEnrichedSpec(record, humanVerifiedFields);

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
        await sendAnalysisReadyEmail(email, { apiName: api.name, pageUrl: `${appOrigin()}/${api.slug}` });
      }
    }

    await db
      .update(analysisRuns)
      .set({ status: 'succeeded', completedAt: new Date(), detail: { pendingCount } })
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
