// Scheduled re-verification (Phase 3).
//
// A verified score is a claim about a live API, and live APIs drift. A score
// verified once and displayed forever is the failure mode this exists to
// prevent: the badge keeps asserting "verified 94" long after the API stopped
// behaving that way.
//
// Two things happen per API, in this order, because the second depends on the
// first:
//   1. If the spec has a source URL, re-fetch it. A changed spec means the
//      normalized model is stale, so re-import before probing — otherwise the
//      probes grade the old shape.
//   2. Re-run the probe engine and write a new score + score_run.
//
// Credentials: probes run with a vaulted credential when the org has one
// (audited as actor 'cron'), and unauthenticated otherwise. An unauthenticated
// run still produces a meaningful auth-clarity result — that probe *wants* to
// send an unauthenticated request — it just cannot grade error quality or drift
// on endpoints that require a key, which the engine already reports as
// insufficient data rather than as failure.

import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import type { Db, NeonDb } from './db';
import { apis, orgs, scores, scoreRuns, specVersions } from './db/schema';
import { runImport } from './importer';
import { loadPersistentRecord } from './persistentApi';
import { PLAN_LIMITS, type Plan } from './plans';
import { reimportApi } from './persist';
import { runScoreEngine } from './probes/run';
import { applyScoreRun } from './scoreWrite';
import { resolveCredential } from './vaultStore';

// How stale a verified score may get before it is re-run. Env-overridable
// because the right cadence is a product decision, not a code one.
export function verifyIntervalHours(): number {
  const raw = process.env.SCHEDULED_VERIFY_INTERVAL_HOURS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 168; // weekly
}

// Bounded per invocation: probes make real upstream requests and the function
// has a wall-clock limit, so the cron takes a small batch of the *stalest* APIs
// each run rather than trying to sweep everything and timing out halfway.
export function batchSize(): number {
  const raw = process.env.SCHEDULED_VERIFY_BATCH;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(25, Math.floor(n)) : 5;
}

// Plans whose scheduledVerification flag is set — derived from plans.ts rather
// than hardcoded, so a pricing change doesn't need a change here too.
export function scheduledPlans(): string[] {
  return (Object.keys(PLAN_LIMITS) as Plan[]).filter((p) => PLAN_LIMITS[p].scheduledVerification);
}

export type ReverifyCandidate = {
  apiId: string;
  slug: string;
  orgId: string;
  plan: string;
  specVersionId: string | null;
  sourceUrl: string | null;
  lastVerifiedAt: Date | null;
};

export async function findCandidates(db: Db, limit = batchSize()): Promise<ReverifyCandidate[]> {
  const plans = scheduledPlans();
  if (!plans.length) return [];

  const staleBefore = new Date(Date.now() - verifyIntervalHours() * 3600 * 1000);

  return db
    .select({
      apiId: apis.id,
      slug: apis.slug,
      orgId: apis.orgId,
      plan: orgs.plan,
      specVersionId: apis.currentSpecVersionId,
      sourceUrl: specVersions.sourceUrl,
      lastVerifiedAt: scores.verifiedAt,
    })
    .from(apis)
    .innerJoin(orgs, eq(orgs.id, apis.orgId))
    .leftJoin(scores, eq(scores.apiId, apis.id))
    .leftJoin(specVersions, eq(specVersions.id, apis.currentSpecVersionId))
    .where(
      and(
        eq(apis.claimStatus, 'claimed'),
        sql`${orgs.plan} in ${plans}`,
        // Never verified, or verified longer ago than the cadence allows.
        or(isNull(scores.verifiedAt), sql`${scores.verifiedAt} < ${staleBefore.toISOString()}`),
      ),
    )
    // Stalest first: with a bounded batch, this is what stops one API from
    // being re-verified repeatedly while another is never reached.
    .orderBy(asc(sql`coalesce(${scores.verifiedAt}, '-infinity'::timestamptz)`))
    .limit(limit);
}

export type ReverifyOutcome = {
  slug: string;
  specStatus: 'unchanged' | 'reverted' | 'updated' | 'skipped' | 'refetch_failed';
  scored: boolean;
  total?: number;
  usedVaultedCredential: boolean;
  error?: string;
};

export type ReverifyDeps = {
  // Injected so tests can drive the expensive parts without network or crypto.
  importSpec?: typeof runImport;
  loadRecord?: typeof loadPersistentRecord;
  scoreEngine?: typeof runScoreEngine;
  now?: () => Date;
};

export async function reverifyOne(
  db: NeonDb,
  candidate: ReverifyCandidate,
  deps: ReverifyDeps = {},
): Promise<ReverifyOutcome> {
  const importSpec = deps.importSpec ?? runImport;
  const loadRecord = deps.loadRecord ?? loadPersistentRecord;
  const scoreEngine = deps.scoreEngine ?? runScoreEngine;

  let specStatus: ReverifyOutcome['specStatus'] = 'skipped';

  // Step 1: refresh the spec, if we know where it came from. A pasted spec has
  // no source URL and simply keeps its current version.
  if (candidate.sourceUrl) {
    try {
      const { record, rawText } = await importSpec({ url: candidate.sourceUrl });
      const result = await reimportApi(db, { apiId: candidate.apiId, record, rawText });
      specStatus = result.status;
    } catch (err) {
      // A spec that has moved or gone 404 must not stop the score refresh: the
      // stored model is still the best available, and an unrefreshed score is
      // better than a stale one.
      specStatus = 'refetch_failed';
      console.error('[reverify] spec refetch failed', {
        slug: candidate.slug,
        reason: err instanceof Error ? err.name : 'unknown',
      });
    }
  }

  // Step 2: probe. Reload the record so it reflects any re-import above.
  const record = await loadRecord(candidate.slug);
  if (!record) {
    return { slug: candidate.slug, specStatus, scored: false, usedVaultedCredential: false, error: 'record_unavailable' };
  }

  let upstreamKey: string | undefined;
  let usedVaultedCredential = false;
  if (PLAN_LIMITS[(candidate.plan as Plan) in PLAN_LIMITS ? (candidate.plan as Plan) : 'free'].vaultedCredentials) {
    const resolved = await resolveCredential(db, {
      orgId: candidate.orgId,
      apiId: candidate.apiId,
      environment: 'production',
      actor: { type: 'cron' },
    });
    if (resolved.ok) {
      upstreamKey = resolved.secret;
      usedVaultedCredential = true;
    }
  }

  const [run] = await db.insert(scoreRuns).values({ apiId: candidate.apiId, status: 'running' }).returning();

  try {
    const result = await scoreEngine(record, { upstreamKey });

    // Re-read the current version: step 1 may have moved it, and writing a
    // score against the pre-import version would mis-attribute the evidence.
    const [current] = await db
      .select({ specVersionId: apis.currentSpecVersionId })
      .from(apis)
      .where(eq(apis.id, candidate.apiId))
      .limit(1);
    const specVersionId = current?.specVersionId ?? candidate.specVersionId;
    if (!specVersionId) throw new Error('no current spec version');

    await applyScoreRun(db, {
      apiId: candidate.apiId,
      specVersionId,
      total: result.total,
      subscores: result.subscores,
      evidence: result.evidence,
    });

    await db
      .update(scoreRuns)
      .set({ status: 'succeeded', findings: result, completedAt: new Date() })
      .where(eq(scoreRuns.id, run.id));

    return { slug: candidate.slug, specStatus, scored: true, total: result.total, usedVaultedCredential };
  } catch (err) {
    await db
      .update(scoreRuns)
      .set({ status: 'failed', error: 'Scheduled verification failed', completedAt: new Date() })
      .where(eq(scoreRuns.id, run.id));
    console.error('[reverify] score run failed', {
      slug: candidate.slug,
      reason: err instanceof Error ? err.name : 'unknown',
    });
    return { slug: candidate.slug, specStatus, scored: false, usedVaultedCredential, error: 'score_run_failed' };
  }
}
