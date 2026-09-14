// Persists a canary run: compare each operation's new snapshot against the one
// from last time, write what changed to the ledger, and store the new snapshot
// so the next run has something to compare against.
//
// Split the same way persist.ts and scoreWrite.ts are, and for the same
// reason: buildCanaryStatements() is pure logic against the dialect-agnostic
// Db type (testable on pglite), applyCanaryRun() is the one line that calls
// `.batch()`, which only the Neon driver implements.

import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { buildChangeStatements } from './changes/ledger';
import { diffSnapshots, reconcile, type ObservedShape, type OperationSnapshot } from './changes/observation';
import type { Change } from './changes/diff';
import type { Db, NeonDb } from './db';
import { actions, operationObservations } from './db/schema';
import { fieldMapFor } from './fieldMap';
import type { Action } from './ir';

export type CanaryRunInput = {
  apiId: string;
  specVersionId: string;
  environment?: string;
  snapshots: OperationSnapshot[];
  // The current model, so an observed shape can be reconciled against the
  // documented one. Keyed by the same stable action key the snapshots carry.
  actionsByKey: Map<string, Action>;
  observedAt?: Date;
};

export type CanaryRunResult = {
  statements: BatchItem<'pg'>[];
  changes: Change[];
  // Operations whose live shape disagrees with the documented one — the
  // classic docs-drift case, and what marks an operation `drifted`.
  driftedActionKeys: string[];
  // Operations whose live shape was checked against documented paths and
  // matched — what clears a previous 'drifted' flag.
  consistentActionKeys: string[];
  comparedAgainstPrevious: number;
};

type PreviousRow = { actionKey: string; shape: ObservedShape; sampleCount: number };

// Fenced on environment as well as api + action.
//
// The write path has always stamped `environment` (canaryRun.ts:131) while the
// read ignored it, so a sandbox observation and a production one competed for
// "newest" on the same operation. Whichever ran last became the baseline, and
// the next comparison reported the difference between two ENVIRONMENTS as
// behavioural drift on the contract — a false breaking-change claim, which is
// the one output this canary is built never to make.
//
// Deliberately NOT fenced on spec_version_id. actionKey is documented as
// "stable across versions, unlike actionId" precisely so a shape can be
// compared across a re-import; fencing there would blind the canary to drift
// that appears at the same moment the document changes, which is when it
// matters most. The spec diff records the document side separately.
async function loadPreviousSnapshots(
  db: Db,
  apiId: string,
  actionKeys: string[],
  environment: string,
): Promise<Map<string, PreviousRow>> {
  if (!actionKeys.length) return new Map();
  const rows = await db
    .select({
      actionKey: operationObservations.actionKey,
      shape: operationObservations.shape,
      sampleCount: operationObservations.sampleCount,
      observedAt: operationObservations.observedAt,
    })
    .from(operationObservations)
    .where(
      and(
        eq(operationObservations.apiId, apiId),
        eq(operationObservations.environment, environment),
        inArray(operationObservations.actionKey, actionKeys),
      ),
    )
    .orderBy(desc(operationObservations.observedAt));

  // Newest row per operation wins; the query returns them newest-first, so the
  // first sighting of each key is the one to keep.
  const latest = new Map<string, PreviousRow>();
  for (const row of rows) {
    if (latest.has(row.actionKey)) continue;
    latest.set(row.actionKey, {
      actionKey: row.actionKey,
      shape: (row.shape as ObservedShape | null) ?? {},
      sampleCount: row.sampleCount,
    });
  }
  return latest;
}

// The response field paths the spec documents, in the same addressing the
// observed shape uses, so the two are directly comparable.
function documentedResponsePaths(action: Action): Set<string> {
  return new Set(
    fieldMapFor(action)
      .response.filter((f) => !f.container)
      .map((f) => f.path),
  );
}

export async function buildCanaryStatements(db: Db, input: CanaryRunInput): Promise<CanaryRunResult> {
  const observedAt = input.observedAt ?? new Date();
  const environment = input.environment ?? 'production';
  const actionKeys = input.snapshots.map((s) => s.actionKey);

  const [previous, actionIdByKey] = await Promise.all([
    loadPreviousSnapshots(db, input.apiId, actionKeys, environment),
    db
      .select({ id: actions.id, actionKey: actions.actionKey })
      .from(actions)
      .where(eq(actions.specVersionId, input.specVersionId))
      .then((rows) => new Map(rows.map((r) => [r.actionKey, r.id]))),
  ]);

  const changes: Change[] = [];
  const driftedActionKeys: string[] = [];
  // Operations whose live shape was checked against a non-empty set of
  // documented paths and matched. The inverse of driftedActionKeys, and the
  // path back out of 'drifted'.
  const consistentActionKeys: string[] = [];
  let comparedAgainstPrevious = 0;

  for (const snapshot of input.snapshots) {
    const prior = previous.get(snapshot.actionKey);
    if (prior) {
      comparedAgainstPrevious++;
      changes.push(
        ...diffSnapshots(
          { ...snapshot, shape: prior.shape, sampleCount: prior.sampleCount },
          snapshot,
        ),
      );
    }

    // Reconciliation runs whether or not there was a previous snapshot: the
    // first look at an operation can already show that what it returns is not
    // what its spec promises.
    const action = input.actionsByKey.get(snapshot.actionKey);
    if (action) {
      const documented = documentedResponsePaths(action);
      const { state } = reconcile(snapshot.shape, snapshot.sampleCount, documented);
      if (state === 'behavior_ahead') driftedActionKeys.push(snapshot.actionKey);
      // reconcile also answers 'consistent' when the spec documents NOTHING,
      // which is absence of evidence rather than a match — so that case must
      // not clear a drift flag.
      else if (documented.size > 0) consistentActionKeys.push(snapshot.actionKey);
    }
  }

  const statements: BatchItem<'pg'>[] = [];

  if (input.snapshots.length) {
    statements.push(
      db.insert(operationObservations).values(
        input.snapshots.map((s) => ({
          id: randomUUID(),
          apiId: input.apiId,
          actionId: actionIdByKey.get(s.actionKey) ?? null,
          actionKey: s.actionKey,
          specVersionId: input.specVersionId,
          environment,
          statusCounts: s.statusCounts,
          sampleCount: s.sampleCount,
          shape: s.shape,
          latencyP50Ms: s.latencyP50Ms,
          latencyMaxMs: s.latencyMaxMs,
          observedAt,
        })),
      ),
    );
  }

  if (changes.length) {
    statements.push(
      ...buildChangeStatements(db, {
        apiId: input.apiId,
        // A behavioural change belongs to no spec diff: nothing moved between
        // two documents. `to` records which version was being served when it
        // was seen, and `from` is deliberately null.
        fromSpecVersionId: null,
        toSpecVersionId: input.specVersionId,
        source: 'probe',
        changes,
        actionIdByKey,
        observedAt,
      }).statements,
    );
  }

  // The one place operation_stability is written. 'drifted' means exactly what
  // the column's vocabulary says: this operation's live behaviour no longer
  // matches its documentation.
  if (driftedActionKeys.length) {
    statements.push(
      db
        .update(actions)
        .set({ operationStability: 'drifted' })
        .where(
          and(eq(actions.specVersionId, input.specVersionId), inArray(actions.actionKey, driftedActionKeys)),
        ),
    );
  }

  // The way back. Without this the flag was one-way within a spec version: an
  // operation that drifted once stayed 'drifted' even after the provider fixed
  // it, and only a re-import cleared it, because a new spec version brings new
  // `actions` rows at the column default. A permanent label for a temporary
  // condition is a claim that quietly stops being true.
  //
  // Set only from consistentActionKeys, never from "we saw no drift this run":
  // an operation nobody could sample, or one whose spec documents no response
  // fields, has produced no evidence that it matches — and clearing a warning
  // on absence of evidence is the same mistake as publishing a green score
  // with zero successful calls.
  if (consistentActionKeys.length) {
    statements.push(
      db
        .update(actions)
        .set({ operationStability: 'documented' })
        .where(
          and(
            eq(actions.specVersionId, input.specVersionId),
            inArray(actions.actionKey, consistentActionKeys),
          ),
        ),
    );
  }

  return { statements, changes, driftedActionKeys, consistentActionKeys, comparedAgainstPrevious };
}

export async function applyCanaryRun(db: NeonDb, input: CanaryRunInput): Promise<Omit<CanaryRunResult, 'statements'>> {
  const { statements, ...result } = await buildCanaryStatements(db, input);
  if (statements.length) {
    await db.batch(statements as [BatchItem<'pg'>, ...BatchItem<'pg'>[]]);
  }
  return result;
}
