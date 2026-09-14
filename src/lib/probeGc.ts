// Cleanup that outlives the run that created the fixture.
//
// A write run garbage-collects its own objects before it ends, but a provider
// can refuse a DELETE, a function can die mid-run, and an object can stay
// readable after a 204. Those fixtures are rows in probe_resources with a
// sealed id and an unresolved cleanup_status; every later run for the same API
// and environment starts by trying them again. After MAX_CLEANUP_ATTEMPTS the
// row is quarantined — visible, blocking the run's clean state, and waiting
// for a person — rather than retried forever.

import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import type { Db } from './db';
import { probeCleanupAttempts, probeResources } from './db/schema';
import type { Action, ImportRecord } from './ir';
import { fillParams } from './paramFill';
import { callProbe } from './probes/context';
import type { ProbeContext } from './probes/types';
import { makeRef } from './transient';
import { openCredential, type SealedCredential } from './vault';
import { resourceSealContext } from './writeRun';

export const MAX_CLEANUP_ATTEMPTS = 3;
const RETRYABLE = ['deleted_unconfirmed', 'delete_failed'];

export type ReapInput = {
  apiId: string;
  orgId: string;
  environment: string;
  record: ImportRecord;
  ctx: ProbeContext;
  runId?: string | null;
  max?: number;
  now?: Date;
};

export type ReapResult = { attempted: number; confirmed: number; quarantined: number; failed: number };

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

function itemParamOf(action: Action): string | null {
  const props = (action.paramsSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
  return Object.keys(props).find((k) => props[k]?.['x-docentapi-in'] === 'path') ?? null;
}

export async function reapLeakedResources(db: Db, input: ReapInput): Promise<ReapResult> {
  const now = input.now ?? new Date();
  const max = input.max ?? 5;
  const result: ReapResult = { attempted: 0, confirmed: 0, quarantined: 0, failed: 0 };

  const rows = await db
    .select()
    .from(probeResources)
    .where(
      and(
        eq(probeResources.apiId, input.apiId),
        eq(probeResources.environment, input.environment),
        inArray(probeResources.cleanupStatus, RETRYABLE),
        isNotNull(probeResources.resourceIdCiphertext),
      ),
    )
    .orderBy(asc(probeResources.createdAt))
    .limit(max);

  const sealCtx = resourceSealContext(input.orgId, input.apiId);

  for (const row of rows) {
    result.attempted++;
    const remove = input.record.actions.find((a) => a.id === row.deleteActionKey);
    const read = remove ? input.record.actions.find((a) => a.path === remove.path && a.method.toUpperCase() === 'GET') : undefined;
    const idParam = remove ? itemParamOf(remove) : null;

    const finish = async (status: 'deleted_confirmed' | 'deleted_unconfirmed' | 'delete_failed' | 'quarantined', deleteStatus: number | null, readbackStatus: number | null, attemptResult: string) => {
      const attempts = row.cleanupAttempts + 1;
      const final = status === 'deleted_confirmed' ? status : attempts >= MAX_CLEANUP_ATTEMPTS ? 'quarantined' : status;
      await db
        .update(probeResources)
        .set({
          cleanupStatus: final,
          cleanupAttempts: attempts,
          lastCleanupAt: now,
          ...(final === 'deleted_confirmed'
            ? { deletedAt: now, resourceIdCiphertext: null, resourceIdIv: null, resourceIdAuthTag: null, resourceIdWrappedDek: null, resourceIdKeyVersion: null }
            : {}),
        })
        .where(eq(probeResources.id, row.id));
      await db.insert(probeCleanupAttempts).values({ resourceId: row.id, runId: input.runId ?? null, deleteStatus, readbackStatus, result: attemptResult, attemptedAt: now });
      if (final === 'deleted_confirmed') result.confirmed++;
      else if (final === 'quarantined') result.quarantined++;
      else result.failed++;
    };

    if (!remove || !idParam) {
      await finish('quarantined', null, null, 'delete_failed');
      continue;
    }

    let id: string;
    try {
      const sealed: SealedCredential = {
        scheme: 'aesgcm-hkdf-v1',
        ciphertext: row.resourceIdCiphertext!,
        iv: row.resourceIdIv!,
        authTag: row.resourceIdAuthTag!,
        wrappedDek: row.resourceIdWrappedDek!,
        keyVersion: row.resourceIdKeyVersion ?? 1,
      };
      id = openCredential(sealed, sealCtx);
    } catch {
      await finish('quarantined', null, null, 'delete_failed');
      continue;
    }
    const ref = makeRef(id);
    if (!ref) {
      await finish('quarantined', null, null, 'delete_failed');
      continue;
    }

    const filled = fillParams(remove, { exclude: idParam, deterministic: true, runId: input.runId ?? undefined });
    if (!filled.ok) {
      await finish('quarantined', null, null, 'delete_failed');
      continue;
    }
    const params = { ...filled.params, [idParam]: ref };

    let deleteStatus: number | null = null;
    try {
      deleteStatus = (await callProbe(input.ctx, remove, params)).status;
    } catch {
      await finish('delete_failed', null, null, 'transport_error');
      continue;
    }
    if (!(isSuccess(deleteStatus) || deleteStatus === 404)) {
      await finish('delete_failed', deleteStatus, null, 'delete_failed');
      continue;
    }
    if (!read) {
      // No read to confirm with; a 2xx/404 on DELETE is the best evidence available.
      await finish('deleted_confirmed', deleteStatus, null, 'deleted_confirmed');
      continue;
    }
    let readback: number | null = null;
    try {
      readback = (await callProbe(input.ctx, read, params)).status;
    } catch {
      await finish('deleted_unconfirmed', deleteStatus, null, 'transport_error');
      continue;
    }
    if (readback === 404 || readback === 410) await finish('deleted_confirmed', deleteStatus, readback, 'deleted_confirmed');
    else await finish('deleted_unconfirmed', deleteStatus, readback, 'still_readable');
  }

  return result;
}
