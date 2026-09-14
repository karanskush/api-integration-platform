import { verifySignatureAppRouter } from '@upstash/qstash/nextjs';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { apis, probeRuns } from '@/lib/db/schema';
import { invokeAction } from '@/lib/mcpTools';
import { loadPersistentRecord, loadRecordForVersion } from '@/lib/persistentApi';
import { writeDeadlineMs, writeEffectsPerRun, writeRequestsPerRun } from '@/lib/plans';
import { reapLeakedResources } from '@/lib/probeGc';
import { createBudget, createEffectBudget, withBudget, withEffectBudget, withPacing, withWriteFence } from '@/lib/probes/budget';
import { planResourceFamilies } from '@/lib/probes/families';
import { policyFromConsent } from '@/lib/probes/writePolicy';
import { runWriteLifecycle, type WriteRunResult } from '@/lib/probes/writeRunner';
import type { ProbeContext } from '@/lib/probes/types';
import { probePaceMs } from '@/lib/reverify';
import { resolveProbeCredential } from '@/lib/vaultStore';
import { applyWriteRun, liveObjectsByEntity, loadCleanupContracts } from '@/lib/writeRun';

export const maxDuration = 300;

const qstashReady = Boolean(process.env.QSTASH_CURRENT_SIGNING_KEY && process.env.QSTASH_NEXT_SIGNING_KEY);

// The sandbox write run. Queued by the owner's button, by /verify and by the
// nightly cron (probeJobs.ts); executed here, alone, with its own budgets.
//
// Order: leaked fixtures from earlier runs are collected FIRST (probeGc.ts) —
// cleanup outranks any new experiment — then the families are planned from the
// spec, the owner's consent becomes the policy, and the runner creates, reads,
// updates, deletes and confirms. The ledger is written last, with the §12.11
// terminal state.
//
// QStash retries on a non-2xx. A row in `queued` is the only state this job
// will pick up, and after the first mutation it always answers 200, so a
// retry can never create a second set of objects for the same run.
async function handler(req: Request) {
  let body: { apiId?: unknown; specVersionId?: unknown; runId?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const apiId = typeof body.apiId === 'string' ? body.apiId : '';
  const specVersionId = typeof body.specVersionId === 'string' ? body.specVersionId : '';
  const runId = typeof body.runId === 'string' ? body.runId : '';
  if (!apiId || !specVersionId || !runId) return Response.json({ error: 'Missing apiId, specVersionId or runId' }, { status: 400 });

  const db = getDb();
  const [run] = await db.select({ id: probeRuns.id, status: probeRuns.status }).from(probeRuns).where(eq(probeRuns.id, runId)).limit(1);
  if (!run) return Response.json({ ok: false, skipped: 'unknown_run' });
  if (run.status !== 'queued') return Response.json({ ok: true, skipped: true, status: run.status });

  const fail = async (errorCode: string) => {
    await db.update(probeRuns).set({ status: 'failed_clean', errorCode, completedAt: new Date() }).where(eq(probeRuns.id, runId));
    return Response.json({ ok: false, errorCode });
  };

  const [api] = await db.select({ id: apis.id, orgId: apis.orgId, slug: apis.slug }).from(apis).where(eq(apis.id, apiId)).limit(1);
  if (!api) return fail('unknown_api');

  await db.update(probeRuns).set({ status: 'running' }).where(eq(probeRuns.id, runId));

  // The only place a write run may obtain a key. Consent is checked and its
  // absence audited inside; a key without consent never reaches this function's
  // scope.
  const cred = await resolveProbeCredential(db, {
    orgId: api.orgId,
    apiId: api.id,
    environment: 'sandbox',
    actor: { type: 'probe' },
    requireWriteConsent: true,
  });
  if (!cred.ok) return fail(cred.reason);

  const record = (await loadRecordForVersion(apiId, specVersionId)) ?? (await loadPersistentRecord(api.slug));
  if (!record) return fail('spec_not_found');

  const budgetLimit = writeRequestsPerRun();
  const effectLimit = writeEffectsPerRun();
  const budget = createBudget({ maxRequests: budgetLimit, deadlineMs: writeDeadlineMs() });
  const effects = createEffectBudget(effectLimit);

  const families = planResourceFamilies(record);
  const policy = policyFromConsent(families, { environment: 'sandbox', consentedAt: cred.writeConsentAt ?? new Date() }, effectLimit);

  // The fence admits the operations the policy approved, plus every DELETE in
  // the spec: a fixture an earlier run leaked may belong to a family that is
  // skipped today, and removing an object this product created is always in
  // scope. Nothing else mutating can pass, whatever the runner asks for.
  const allow = new Set(policy.approvedOperations);
  for (const a of record.actions) if (a.method.toUpperCase() === 'DELETE') allow.add(a.name);
  const fenced = withWriteFence(withPacing(invokeAction, probePaceMs()), { environment: 'sandbox', allow });
  const cleanupInvoke = withBudget(fenced, budget);
  const invoke = withBudget(withEffectBudget(fenced, effects), budget);

  const ctx: ProbeContext = { record, upstreamKey: cred.secret, invoke, budget, environment: 'sandbox', runId };

  let result: WriteRunResult | null = null;
  try {
    const reaped = await reapLeakedResources(db, {
      apiId: api.id,
      orgId: api.orgId,
      environment: 'sandbox',
      record,
      ctx: { ...ctx, invoke: cleanupInvoke },
      runId,
    });
    const [contracts, live] = await Promise.all([loadCleanupContracts(db, api.id, 'sandbox'), liveObjectsByEntity(db, api.id, 'sandbox')]);

    result = await runWriteLifecycle(ctx, families, policy, { runId, contracts, effects, liveObjectsByEntity: live, cleanupInvoke });

    const applied = await applyWriteRun(db, {
      runId,
      apiId: api.id,
      orgId: api.orgId,
      specVersionId,
      environment: 'sandbox',
      credentialId: cred.credentialId,
      result,
      budgetLimit,
      effectBudget: effectLimit,
    });
    return Response.json({ ok: true, status: applied.status, reaped, families: result.families.length, requests: result.requestsMade });
  } catch (err) {
    // Name only: an ssrf.ts rejection carries the URL it refused, and for a
    // write run that URL can carry a created identifier.
    console.error('[probe-sandbox] failed', { apiId, runId, reason: err instanceof Error ? err.name : 'unknown' });
    // If the runner finished but the ledger write failed, the identifiers are
    // gone with the function. Say so: created minus confirmed is quarantined.
    const created = result?.created ?? 0;
    const confirmed = result?.deletedConfirmed ?? 0;
    const quarantined = Math.max(0, created - confirmed);
    await db
      .update(probeRuns)
      .set({
        status: quarantined > 0 ? 'failed_with_quarantined_resources' : 'failed_clean',
        errorCode: result ? 'ledger_write_failed' : 'run_failed',
        requestsMade: result?.requestsMade ?? 0,
        createdCount: created,
        deletedConfirmedCount: confirmed,
        quarantinedCount: quarantined,
        completedAt: new Date(),
      })
      .where(eq(probeRuns.id, runId));
    return Response.json({ ok: false, errorCode: result ? 'ledger_write_failed' : 'run_failed' });
  }
}

export const POST = qstashReady
  ? verifySignatureAppRouter(handler)
  : async () => Response.json({ error: 'Job queue is not configured' }, { status: 503 });
