// Persisting a write run: the run row with its §12.11 terminal state, the
// resource ledger, the cleanup attempts, the rehearsed contracts, and the
// evidence — the lineageRun.ts split, for the write runner.
//
// THE ONE EXCEPTION TO ZERO-VALUE STORAGE. A created object's identifier has to
// be kept until its deletion is confirmed, or a leaked fixture could never be
// cleaned up. It is stored sealed under the vault KEK (vault.ts, the same
// envelope as a credential), in a row scoped to the fixture the runner itself
// created, and the sealed columns are NULLed the moment deletion is confirmed;
// only the HMAC survives. resolveParams() is the audited unwrap boundary and is
// used here for exactly that reason.

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { Db, NeonDb } from './db';
import { cleanupContracts, probeCleanupAttempts, probeResources, probeRuns } from './db/schema';
import type { CreatedResource, WriteRunResult } from './probes/writeRunner';
import { terminalStateFor, type TerminalRunState } from './probes/policy';
import { buildEvidenceStatements } from './scoreWrite';
import { resolveParams } from './transient';
import { credentialFingerprint, sealCredential, type CredentialContext } from './vault';

/** The vault context under which fixture ids are sealed — never a credential's. */
export function resourceSealContext(orgId: string, apiId: string): CredentialContext {
  return { orgId, apiId, environment: 'probe-resource', keyVersion: 1 };
}

export type WriteRunInput = {
  runId: string;
  apiId: string;
  orgId: string;
  specVersionId: string;
  environment: 'sandbox';
  credentialId: string | null;
  result: WriteRunResult;
  budgetLimit: number;
  effectBudget: number;
  now?: Date;
};

export type WriteRunApplied = { status: TerminalRunState; quarantined: number; resourcesWritten: number };

function attemptResult(r: CreatedResource): string | null {
  if (r.deleteStatus === null && r.readbackStatus === null) return null;
  switch (r.cleanup) {
    case 'deleted_confirmed':
      return 'deleted_confirmed';
    case 'deleted_unconfirmed':
      return 'still_readable';
    case 'delete_failed':
      return 'delete_failed';
    default:
      return null;
  }
}

export async function buildWriteRunStatements(db: Db, input: WriteRunInput): Promise<{ statements: BatchItem<'pg'>[]; applied: WriteRunApplied }> {
  const now = input.now ?? new Date();
  const { result } = input;
  const ctx = resourceSealContext(input.orgId, input.apiId);
  const statements: BatchItem<'pg'>[] = [];

  const status = terminalStateFor(result.outcome, result.quarantined);
  statements.push(
    db
      .update(probeRuns)
      .set({
        status,
        familiesPlanned: result.families.length,
        familiesExecuted: result.families.filter((f) => !f.skipped).length,
        requestsMade: result.requestsMade,
        budgetLimit: input.budgetLimit,
        effectsUsed: result.effectsUsed,
        effectBudget: input.effectBudget,
        createdCount: result.created,
        deletedConfirmedCount: result.deletedConfirmed,
        quarantinedCount: result.quarantined,
        abortedReason: result.aborted,
        credentialId: input.credentialId,
        completedAt: now,
      })
      .where(eq(probeRuns.id, input.runId)),
  );

  let resourcesWritten = 0;
  for (const r of result.resources) {
    // The id leaves its ValueRef here and only here, straight into the seal.
    const id = r.ref ? String(resolveParams({ id: r.ref }).id) : null;
    const confirmed = r.cleanup === 'deleted_confirmed';
    const sealed = id && !confirmed ? sealCredential(id, ctx) : null;
    const hash = id ? credentialFingerprint(id, ctx) : `unavailable:${input.runId}:${resourcesWritten}`;
    const resourceId = crypto.randomUUID();
    resourcesWritten++;
    statements.push(
      db.insert(probeResources).values({
        id: resourceId,
        runId: input.runId,
        apiId: input.apiId,
        orgId: input.orgId,
        environment: input.environment,
        entity: r.entity.slice(0, 64),
        createActionKey: r.createActionKey,
        deleteActionKey: r.deleteActionKey,
        resourceIdHash: hash,
        resourceIdCiphertext: sealed?.ciphertext ?? null,
        resourceIdIv: sealed?.iv ?? null,
        resourceIdAuthTag: sealed?.authTag ?? null,
        resourceIdWrappedDek: sealed?.wrappedDek ?? null,
        resourceIdKeyVersion: sealed?.keyVersion ?? null,
        idSource: r.idSource,
        cleanupStatus: r.cleanup,
        cleanupAttempts: r.deleteStatus === null ? 0 : 1,
        deletedAt: confirmed ? now : null,
        lastCleanupAt: r.deleteStatus === null ? null : now,
      }),
    );
    const outcome = attemptResult(r);
    if (outcome) {
      statements.push(
        db.insert(probeCleanupAttempts).values({
          resourceId,
          runId: input.runId,
          deleteStatus: r.deleteStatus,
          readbackStatus: r.readbackStatus,
          result: outcome,
          attemptedAt: now,
        }),
      );
    }
  }

  for (const operation of result.contractsRehearsed) {
    statements.push(
      db
        .insert(cleanupContracts)
        .values({
          apiId: input.apiId,
          environment: input.environment,
          operation,
          mechanism: 'inverse_operation',
          approvedAt: now,
          testedAt: now,
          testedRunId: input.runId,
        })
        .onConflictDoUpdate({
          target: [cleanupContracts.apiId, cleanupContracts.environment, cleanupContracts.operation],
          set: { testedAt: now, testedRunId: input.runId },
        }),
    );
  }

  statements.push(
    ...(await buildEvidenceStatements(db, {
      apiId: input.apiId,
      specVersionId: input.specVersionId,
      environment: input.environment,
      evidence: result.evidence,
    })),
  );

  return { statements, applied: { status, quarantined: result.quarantined, resourcesWritten } };
}

export async function applyWriteRun(db: NeonDb, input: WriteRunInput): Promise<WriteRunApplied> {
  const { statements, applied } = await buildWriteRunStatements(db, input);
  if (statements.length) await db.batch(statements as [BatchItem<'pg'>, ...BatchItem<'pg'>[]]);
  return applied;
}

/** create tool name → whether its contract has been rehearsed, for this API and environment. */
export async function loadCleanupContracts(db: Db, apiId: string, environment: string): Promise<Map<string, boolean>> {
  const rows = await db
    .select({ operation: cleanupContracts.operation, testedAt: cleanupContracts.testedAt })
    .from(cleanupContracts)
    .where(and(eq(cleanupContracts.apiId, apiId), eq(cleanupContracts.environment, environment)));
  return new Map(rows.map((r) => [r.operation, r.testedAt !== null]));
}

const UNRESOLVED = ['deleted_unconfirmed', 'delete_failed', 'quarantined'];

/** Unresolved fixtures per entity, so the leak cap counts what earlier runs left behind. */
export async function liveObjectsByEntity(db: Db, apiId: string, environment: string): Promise<Map<string, number>> {
  const rows = await db
    .select({ entity: probeResources.entity, count: sql<number>`count(*)::int` })
    .from(probeResources)
    .where(and(eq(probeResources.apiId, apiId), eq(probeResources.environment, environment), inArray(probeResources.cleanupStatus, UNRESOLVED)))
    .groupBy(probeResources.entity);
  return new Map(rows.map((r) => [r.entity, r.count]));
}
