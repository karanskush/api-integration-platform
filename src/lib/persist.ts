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
import { eq } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { Db, NeonDb } from './db';
import { actions, apis, evidenceFacts, scorePreviews, specVersions } from './db/schema';
import type { ImportRecord } from './ir';
import { scorePreview as computeScorePreview } from './scorePreview';
import { allocateApiSlug } from './slug';

export type PersistInput = {
  orgId: string;
  createdBy?: string;
  record: ImportRecord;
  rawText: string;
  claimStatus?: 'unclaimed' | 'claimed';
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
  const { orgId, createdBy, record, rawText, claimStatus } = input;
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
  return { apiId, slug, specVersionId };
}
