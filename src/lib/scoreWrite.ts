// Persists a completed runScoreEngine() result — the live-probe counterpart
// to persist.ts's parser-driven scorePreviews write. Same split for the same
// reason: buildScoreRunStatements() is pure logic against the
// dialect-agnostic Db type (unit-testable via pglite); applyScoreRun() is
// the one line that calls `.batch()`, which only NeonDb implements. See
// persist.ts's header comment for why neon-http needs `.batch()` instead of
// a real transaction, and why every id below is generated client-side.

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { buildLifecycleChangeStatements, type LifecycleFactInput } from './changes/ledger';
import type { Db, NeonDb } from './db';
import { actions, evidenceFacts, scores } from './db/schema';
import type { EvidenceFactInput, EvidencePayload } from './evidence';

export type ScoreRunInput = {
  apiId: string;
  specVersionId: string;
  total: number;
  subscores: {
    authClarity: number;
    errorQuality: number | null;
    docDrift: number | null;
    idempotency: number;
  };
  evidence: EvidenceFactInput[];
};

export type ScoreRunStatements = { statements: BatchItem<'pg'>[] };

// The kinds that actually MOVED the number. A probe run now also records
// lifecycle headers, which are provider announcements rather than measurements
// — listing them under "why this API scored what it scored" would claim they
// contributed when they did not.
const SCORING_KINDS = new Set<EvidenceFactInput['kind']>([
  'probe.auth_reject',
  'probe.error_quality',
  'probe.doc_drift',
  'probe.idempotency_signal',
]);

function describeEvidence(e: EvidenceFactInput): string {
  switch (e.kind) {
    case 'probe.auth_reject': {
      const p = e.payload as EvidencePayload['probe.auth_reject'];
      return `Auth clarity: a request without valid ${p.expectedAuth} credentials was rejected with ${p.statusObserved}`;
    }
    case 'probe.error_quality': {
      const p = e.payload as EvidencePayload['probe.error_quality'];
      return p.hasReadableMessage
        ? `Error quality: ${p.actionId} returned a readable error message on a ${p.sampleStatus} response`
        : `Error quality: ${p.actionId} returned an unreadable error on a ${p.sampleStatus} response`;
    }
    case 'probe.doc_drift': {
      const p = e.payload as EvidencePayload['probe.doc_drift'];
      return `Doc drift: ${p.actionId} response matched ${p.matchedFields}/${p.declaredFields} documented fields`;
    }
    case 'probe.idempotency_signal': {
      const p = e.payload as EvidencePayload['probe.idempotency_signal'];
      return p.hasIdempotencySignal
        ? `Idempotency: ${p.actionId} accepts an idempotency-style param (${p.matchedParam})`
        : `Idempotency: ${p.actionId} exposes no idempotency-style param`;
    }
    default:
      return `${e.kind.replace('parser.', '').replace('probe.', '')}: contributed to score`;
  }
}

// Probe evidence carries Action.id (the stable hash(method+path) key —
// see ir.ts), not the actions row's DB-generated uuid that evidence_facts.
// action_id actually references — so every actionId has to be resolved
// against this spec version's action rows before insert, or the FK column
// rejects the non-uuid key outright.
async function resolveActionIds(db: Db, specVersionId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: actions.id, actionKey: actions.actionKey })
    .from(actions)
    .where(eq(actions.specVersionId, specVersionId));
  return new Map(rows.map((r) => [r.actionKey, r.id]));
}

export async function buildScoreRunStatements(db: Db, input: ScoreRunInput): Promise<ScoreRunStatements> {
  const { apiId, specVersionId, total, subscores, evidence } = input;
  const actionIdByKey = await resolveActionIds(db, specVersionId);
  const factIds = evidence.map(() => randomUUID());

  const statements: BatchItem<'pg'>[] = [];

  if (evidence.length) {
    statements.push(
      db.insert(evidenceFacts).values(
        evidence.map((e, i) => ({
          id: factIds[i],
          apiId,
          specVersionId,
          actionId: e.actionId ? (actionIdByKey.get(e.actionId) ?? null) : null,
          kind: e.kind,
          source: e.source || 'probe',
          environment: e.environment ?? (e.kind === 'probe.idempotency_signal' ? 'static' : 'production'),
          confidence: e.confidence ?? 1,
          payload: e.payload,
        })),
      ),
    );
  }

  // Lifecycle observations become ledger rows so the changelog shows "the
  // provider announced a sunset on this endpoint" alongside spec diffs. The
  // partial unique index makes the repeat-observation case a no-op, so this is
  // safe to run on every score run without a read-before-write.
  const lifecycleFacts: LifecycleFactInput[] = [];
  for (const e of evidence) {
    if (e.kind !== 'probe.lifecycle_signal') continue;
    const p = e.payload as EvidencePayload['probe.lifecycle_signal'];
    lifecycleFacts.push({
      actionKey: p.actionId,
      tool: p.tool,
      method: p.method,
      path: p.path,
      signal: { kind: p.kind, header: p.header, raw: p.raw, ...(p.at ? { at: p.at } : {}), ...(p.url ? { url: p.url } : {}) },
    });
  }
  statements.push(
    ...buildLifecycleChangeStatements(db, { apiId, specVersionId, facts: lifecycleFacts, actionIdByKey }),
  );

  const explanation = evidence
    .map((e, i) => ({ factId: factIds[i], kind: e.kind, message: describeEvidence(e) }))
    .filter((e) => SCORING_KINDS.has(e.kind))
    .map(({ factId, message }) => ({ factId, message }));
  const scoreValues = {
    specVersionId,
    total,
    authClarity: subscores.authClarity,
    errorQuality: subscores.errorQuality,
    docDrift: subscores.docDrift,
    idempotency: subscores.idempotency,
    explanation,
  };

  statements.push(
    db
      .insert(scores)
      .values({ apiId, ...scoreValues })
      .onConflictDoUpdate({ target: scores.apiId, set: { ...scoreValues, verifiedAt: new Date() } }),
  );

  return { statements };
}

export async function applyScoreRun(db: NeonDb, input: ScoreRunInput): Promise<void> {
  const { statements } = await buildScoreRunStatements(db, input);
  await db.batch(statements as [BatchItem<'pg'>, ...BatchItem<'pg'>[]]);
}
