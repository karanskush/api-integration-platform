// Queuing a sandbox write run. One helper shared by the owner's button, the
// on-demand verification route and the nightly cron, so the row a job later
// picks up is always shaped the same way.

import { and, eq, gt, inArray } from 'drizzle-orm';
import type { Db } from './db';
import { credentials, probeRuns } from './db/schema';
import { writeEffectsPerRun, writeRequestsPerRun } from './plans';
import { publishJob, queueReady } from './queue';

export type EnqueueInput = {
  apiId: string;
  specVersionId: string;
  credentialId: string | null;
  triggeredBy: 'owner' | 'cron' | 'verify';
};

export type EnqueueResult = { queued: true; runId: string } | { queued: false; reason: 'queue_unavailable' };

export async function enqueueSandboxWriteRun(db: Db, input: EnqueueInput): Promise<EnqueueResult> {
  if (!queueReady()) return { queued: false, reason: 'queue_unavailable' };
  const [run] = await db
    .insert(probeRuns)
    .values({
      apiId: input.apiId,
      specVersionId: input.specVersionId,
      environment: 'sandbox',
      kind: 'write_lifecycle',
      status: 'queued',
      budgetLimit: writeRequestsPerRun(),
      effectBudget: writeEffectsPerRun(),
      credentialId: input.credentialId,
      triggeredBy: input.triggeredBy,
    })
    .returning({ id: probeRuns.id });
  await publishJob('/api/jobs/probe-sandbox', { apiId: input.apiId, specVersionId: input.specVersionId, runId: run.id });
  return { queued: true, runId: run.id };
}

export type MaybeEnqueueResult =
  | { queued: true; runId: string }
  | { queued: false; reason: 'queue_unavailable' | 'no_write_consent' | 'already_running' };

/**
 * The verify route and the nightly cron call this after a read run: queue a
 * write run only when the org has a sandbox key WITH write consent, the queue
 * is configured, and no write run for the API is already in flight.
 */
export async function maybeEnqueueSandboxWriteRun(
  db: Db,
  input: { apiId: string; specVersionId: string; triggeredBy: 'cron' | 'verify' },
): Promise<MaybeEnqueueResult> {
  if (!queueReady()) return { queued: false, reason: 'queue_unavailable' };
  const [cred] = await db
    .select({ id: credentials.id, writeConsentAt: credentials.writeConsentAt })
    .from(credentials)
    .where(and(eq(credentials.apiId, input.apiId), eq(credentials.environment, 'sandbox')))
    .limit(1);
  if (!cred?.writeConsentAt) return { queued: false, reason: 'no_write_consent' };
  const inFlight = await db
    .select({ id: probeRuns.id })
    .from(probeRuns)
    .where(and(eq(probeRuns.apiId, input.apiId), inArray(probeRuns.status, ['queued', 'running']), gt(probeRuns.startedAt, new Date(Date.now() - IN_FLIGHT_WINDOW_MS))))
    .limit(1);
  if (inFlight.length) return { queued: false, reason: 'already_running' };
  const result = await enqueueSandboxWriteRun(db, { ...input, credentialId: cred.id });
  return result.queued ? result : { queued: false, reason: 'queue_unavailable' };
}

/** A run still marked queued or running after this long is presumed dead, not in flight. */
export const IN_FLIGHT_WINDOW_MS = 15 * 60_000;
