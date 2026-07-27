// Turns an ephemeral ImportRecord into persistent rows — used by both the
// "claim an ephemeral import" flow and a direct authenticated persist.
//
// IMPORTANT: neon-http (the driver db.ts uses in production) does NOT
// support interactive transactions — `db.transaction(async tx => ...)`
// throws "No transactions support in neon-http driver". Atomicity here
// instead comes from `db.batch([...])`, which sends every statement in one
// HTTP round trip inside one Postgres transaction on Neon's side. batch()
// can't reference a prior statement's DB-generated id mid-batch, so every id
// below is generated client-side up front — that's what makes a flat,
// order-independent statement list possible instead of a dependent
// read-then-write chain.
//
// This file is split in two on purpose:
//   - buildPersistStatements(): pure logic (slug allocation, content hash,
//     row shapes, evidence/score linkage) against the dialect-agnostic Db
//     type — fully unit-testable against the pglite harness.
//   - persistApi(): the one line that calls `.batch()`, which only exists on
//     the concrete Neon driver (NeonDb) and pglite's driver doesn't
//     implement — this line can only be verified against a real Neon
//     connection (see plan verification notes), not a unit test.

import { randomUUID, createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { Db, NeonDb } from './db';
import { actions, apis, evidenceFacts, scorePreviews, specVersions } from './db/schema';
import type { ImportRecord } from './ir';
import { buildLineageEvidenceStatements } from './lineageEvidence';
import { scorePreview as computeScorePreview } from './scorePreview';
import { allocateApiSlug } from './slug';
import { blobReady, putSpecSnapshot } from './specStore';

export type PersistInput = {
  orgId: string;
  createdBy?: string;
  record: ImportRecord;
  rawText: string;
  claimStatus?: 'unclaimed' | 'claimed';
  // Omitted (column default 'complete') for every existing caller — only the
  // authenticated /api/apis/analyze route passes 'queued' to enter the deep
  // pipeline. See schema.ts's analysisStatus comment for why the default
  // isn't 'queued'.
  analysisStatus?: 'queued' | 'complete';
};

export type PersistResult = { apiId: string; slug: string; specVersionId: string };

export type PersistStatements = PersistResult & { statements: BatchItem<'pg'>[] };

// Plan-based caps (maxPersistentApis etc.) are enforced by the caller BEFORE
// invoking this — wired in once billing (plans.ts, task 7) exists — not here.
//
// Every claim/persist call creates a brand-new `apis` row with a freshly
// allocated slug; there is no "re-import into an existing persistent api"
// path yet (that's dashboard-feature work, not built here), so the
// spec_versions (api_id, content_hash) unique constraint can never actually
// conflict today — onConflictDoNothing is defensive, ahead of that feature.
export async function buildPersistStatements(db: Db, input: PersistInput): Promise<PersistStatements> {
  const { orgId, createdBy, record, rawText, claimStatus, analysisStatus } = input;
  const contentHash = createHash('sha256').update(rawText).digest('hex');

  const slug = await allocateApiSlug(record.name, async (candidate) => {
    const rows = await db.select({ id: apis.id }).from(apis).where(eq(apis.slug, candidate)).limit(1);
    return rows.length > 0;
  });

  const apiId = randomUUID();
  const specVersionId = randomUUID();
  const preview = computeScorePreview(record);
  const factIds = preview.checks.map(() => randomUUID());

  const statements: BatchItem<'pg'>[] = [
    db.insert(apis).values({
      id: apiId,
      orgId,
      slug,
      name: record.name,
      createdBy,
      baseUrls: record.baseUrls,
      dominantAuth: record.auth,
      authIn: record.authIn ?? null,
      ...(claimStatus !== undefined ? { claimStatus } : {}),
      ...(analysisStatus !== undefined ? { analysisStatus } : {}),
    }),
    db
      .insert(specVersions)
      .values({
        id: specVersionId,
        apiId,
        source: record.source,
        sourceUrl: record.sourceUrl,
        contentHash,
        parseStatus: 'parsed',
        actionCount: record.actions.length,
      })
      .onConflictDoNothing({ target: [specVersions.apiId, specVersions.contentHash] }),
  ];

  if (record.actions.length) {
    statements.push(
      db.insert(actions).values(
        record.actions.map((a) => ({
          apiId,
          specVersionId,
          actionKey: a.id,
          name: a.name,
          description: a.description,
          method: a.method,
          path: a.path,
          paramsSchema: a.paramsSchema,
          responseSchemas: a.responseSchema ?? null,
          errorSchemas: a.errorSchema ?? null,
          scopes: a.scopes ?? null,
          auth: a.auth,
          authIn: a.authIn ?? null,
          safety: a.safety,
          examples: a.examples,
        })),
      ),
    );
  }

  statements.push(
    db.insert(evidenceFacts).values(
      preview.checks.map((c, i) => ({
        id: factIds[i],
        apiId,
        specVersionId,
        kind: `parser.${c.id}`,
        source: 'parser',
        payload: { points: c.points, maxPoints: c.maxPoints, message: c.message },
      })),
    ),
    db.insert(scorePreviews).values({
      apiId,
      specVersionId,
      total: preview.total,
      subscores: preview.checks,
      explanation: preview.checks.map((c, i) => ({ factId: factIds[i], message: c.message })),
    }),
    ...buildLineageEvidenceStatements(db, { apiId, specVersionId, record }),
    // Only ever flips to a version whose rows were just written in this same
    // atomic batch — a mid-batch failure rolls the whole thing back on
    // Neon's side, so this never points at a half-written version.
    db.update(apis).set({ currentSpecVersionId: specVersionId }).where(eq(apis.id, apiId)),
  );

  return { apiId, slug, specVersionId, statements };
}

export async function persistApi(db: NeonDb, input: PersistInput): Promise<PersistResult> {
  const { apiId, slug, specVersionId, statements } = await buildPersistStatements(db, input);
  await db.batch(statements as [BatchItem<'pg'>, ...BatchItem<'pg'>[]]);
  await attachSnapshot(db, specVersionId, input.rawText);
  return { apiId, slug, specVersionId };
}

// Writes the raw spec to Blob and records the pointer, AFTER the rows are
// committed. Deliberately not inside the batch: the batch is one atomic
// Postgres transaction and a blob write cannot participate in it, so folding
// them together would mean either a rolled-back import with an orphan blob or a
// committed import lost to a blob outage. This ordering makes the snapshot
// strictly additive — worst case blob_ref stays null and the import is fine.
async function attachSnapshot(db: Db, specVersionId: string, rawText: string): Promise<void> {
  if (!blobReady()) return;
  const contentHash = createHash('sha256').update(rawText).digest('hex');
  const snapshot = await putSpecSnapshot(contentHash, rawText);
  if (!snapshot) return;
  try {
    await db.update(specVersions).set({ blobRef: snapshot.blobRef }).where(eq(specVersions.id, specVersionId));
  } catch (err) {
    console.error('[persist] blob_ref update failed', { reason: err instanceof Error ? err.name : 'unknown' });
  }
}

// ---------------------------------------------------------------------------
// Re-import: a new spec version for an API that already exists.
//
// buildPersistStatements() above always mints a fresh apis row, which is right
// for a first import and wrong for every subsequent one — it would fork a
// second page rather than version the existing one. This is the path CI sync
// (api/ci/sync) and scheduled re-verification need, and it is what makes
// spec_versions' (api_id, content_hash) unique constraint load-bearing at last.
//
// Three outcomes, decided by content hash:
//   unchanged — the hash already IS the current version. No writes at all, so a
//               CI job that runs on every push is free when the spec is stable.
//   reverted  — the hash matches an older version of this API. The action rows
//               for it are still on disk (they are keyed by spec_version_id),
//               so pointing current back at it is the entire operation.
//   updated   — genuinely new content: version, actions, evidence, preview.

export type ReimportInput = { apiId: string; record: ImportRecord; rawText: string };

export type ReimportStatus = 'unchanged' | 'reverted' | 'updated';

export type ReimportStatements = {
  status: ReimportStatus;
  specVersionId: string;
  contentHash: string;
  statements: BatchItem<'pg'>[];
};

export async function buildReimportStatements(db: Db, input: ReimportInput): Promise<ReimportStatements> {
  const { apiId, record, rawText } = input;
  const contentHash = createHash('sha256').update(rawText).digest('hex');

  const [api] = await db
    .select({ currentSpecVersionId: apis.currentSpecVersionId })
    .from(apis)
    .where(eq(apis.id, apiId))
    .limit(1);

  const [existing] = await db
    .select({ id: specVersions.id })
    .from(specVersions)
    .where(and(eq(specVersions.apiId, apiId), eq(specVersions.contentHash, contentHash)))
    .limit(1);

  if (existing && api?.currentSpecVersionId === existing.id) {
    return { status: 'unchanged', specVersionId: existing.id, contentHash, statements: [] };
  }

  // Metadata that can legitimately move between versions of the same spec.
  const apiUpdate = {
    baseUrls: record.baseUrls,
    dominantAuth: record.auth,
    authIn: record.authIn ?? null,
    updatedAt: new Date(),
  };

  if (existing) {
    return {
      status: 'reverted',
      specVersionId: existing.id,
      contentHash,
      statements: [
        db
          .update(apis)
          .set({ ...apiUpdate, currentSpecVersionId: existing.id })
          .where(eq(apis.id, apiId)),
      ],
    };
  }

  const specVersionId = randomUUID();
  const preview = computeScorePreview(record);
  const factIds = preview.checks.map(() => randomUUID());

  const statements: BatchItem<'pg'>[] = [
    db.insert(specVersions).values({
      id: specVersionId,
      apiId,
      source: record.source,
      sourceUrl: record.sourceUrl,
      contentHash,
      parseStatus: 'parsed',
      actionCount: record.actions.length,
    }),
  ];

  if (record.actions.length) {
    statements.push(
      db.insert(actions).values(
        record.actions.map((a) => ({
          apiId,
          specVersionId,
          actionKey: a.id,
          name: a.name,
          description: a.description,
          method: a.method,
          path: a.path,
          paramsSchema: a.paramsSchema,
          responseSchemas: a.responseSchema ?? null,
          errorSchemas: a.errorSchema ?? null,
          scopes: a.scopes ?? null,
          auth: a.auth,
          authIn: a.authIn ?? null,
          safety: a.safety,
          examples: a.examples,
        })),
      ),
    );
  }

  const previewValues = {
    specVersionId,
    total: preview.total,
    subscores: preview.checks,
    explanation: preview.checks.map((c, i) => ({ factId: factIds[i], message: c.message })),
  };

  statements.push(
    // Evidence is append-only: the old version's facts stay, carrying their own
    // spec_version_id, so a score can still be explained after a re-import.
    db.insert(evidenceFacts).values(
      preview.checks.map((c, i) => ({
        id: factIds[i],
        apiId,
        specVersionId,
        kind: `parser.${c.id}`,
        source: 'parser',
        payload: { points: c.points, maxPoints: c.maxPoints, message: c.message },
      })),
    ),
    // score_previews is one-current-row-per-api, so this replaces rather than
    // accumulates (unlike evidence above).
    db
      .insert(scorePreviews)
      .values({ apiId, ...previewValues })
      .onConflictDoUpdate({ target: scorePreviews.apiId, set: { ...previewValues, computedAt: new Date() } }),
    // Also append-only, like the evidence above: field relationships can
    // change between spec versions (a field renamed, a new producer added), so
    // each version gets its own recomputed set rather than patching the last.
    ...buildLineageEvidenceStatements(db, { apiId, specVersionId, record }),
    db
      .update(apis)
      .set({ ...apiUpdate, currentSpecVersionId: specVersionId })
      .where(eq(apis.id, apiId)),
  );

  return { status: 'updated', specVersionId, contentHash, statements };
}

export type ReimportResult = { status: ReimportStatus; specVersionId: string; contentHash: string };

export async function reimportApi(db: NeonDb, input: ReimportInput): Promise<ReimportResult> {
  const { status, specVersionId, contentHash, statements } = await buildReimportStatements(db, input);
  if (statements.length) {
    await db.batch(statements as [BatchItem<'pg'>, ...BatchItem<'pg'>[]]);
  }
  // Only a genuinely new version needs a snapshot: 'unchanged' and 'reverted'
  // both point at a version whose bytes are already stored.
  if (status === 'updated') {
    await attachSnapshot(db, specVersionId, input.rawText);
  }
  return { status, specVersionId, contentHash };
}
