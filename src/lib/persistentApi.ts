import { and, eq, inArray } from 'drizzle-orm';
import { dbReady, getDb, type Db } from './db';
import { actions as actionsTable, apis, scores, specVersions } from './db/schema';
import type { Action, ImportRecord, ImportSource, Webhook } from './ir';

export type VerifiedScore = {
  total: number;
  authClarity: number;
  errorQuality: number | null;
  docDrift: number | null;
  idempotency: number;
  explanation: { factId: string; message: string }[];
  // Version fencing (GAP_ANALYSIS_2026-08-04.md §0.3). A score is a claim about
  // ONE spec version; when the API's current version moves past it, the score
  // still exists but describes a contract that no longer serves, and every
  // renderer must say so rather than keep showing green.
  stale: boolean;
  verifiedAt: string; // ISO
  specVersionId: string;
  // The sample the number rests on (GAP_ANALYSIS_2026-08-04.md §0.2). A row is
  // only written when at least one upstream call succeeded, so this is what
  // makes "verified" mean something to a reader. 0 on rows written before the
  // accounting existed, which the panel reports as unknown rather than as none.
  liveCallsAttempted: number;
  liveCallsSucceeded: number;
};

export type ApiVerificationState = {
  apiId: string;
  name: string;
  orgId: string;
  claimStatus: string;
  analysisStatus: string;
  currentSpecVersionId: string | null;
  scores: VerifiedScore | null;
};

// Exported for the reimport diff (persist.ts), which needs the previous
// version's actions in IR shape without going through getDb().
export function toAction(row: typeof actionsTable.$inferSelect): Action {
  return {
    id: row.actionKey,
    name: row.name,
    description: row.description,
    method: row.method,
    path: row.path,
    paramsSchema: row.paramsSchema as Action['paramsSchema'],
    auth: row.auth as Action['auth'],
    authIn: (row.authIn as Action['authIn']) ?? undefined,
    safety: row.safety as Action['safety'],
    examples: (row.examples as Action['examples']) ?? [],
    responseSchema: (row.responseSchemas as Action['responseSchema']) ?? undefined,
    errorSchema: (row.errorSchemas as Action['errorSchema']) ?? undefined,
    scopes: (row.scopes as Action['scopes']) ?? undefined,
    // Omitted (not false / null) when unset so a restored action is
    // deep-equal to the IR the importer produced — the diff engine relies on
    // that equivalence to report "no change" for an unchanged operation.
    ...(row.deprecated ? { deprecated: true } : {}),
    ...(row.sunsetAt ? { sunsetAt: row.sunsetAt.toISOString() } : {}),
  };
}

type ApiRow = typeof apis.$inferSelect;

// One version's actions in IR shape, plus the action_key → row id map the
// change ledger needs to point api_changes.action_id at a concrete row. Takes
// the db explicitly (not getDb()) so the reimport path and the pglite tests
// can call it against whichever connection they hold.
export async function loadActionsForVersion(
  db: Db,
  apiId: string,
  specVersionId: string,
): Promise<{ actions: Action[]; idByKey: Map<string, string> }> {
  const rows = await db
    .select()
    .from(actionsTable)
    .where(and(eq(actionsTable.apiId, apiId), eq(actionsTable.specVersionId, specVersionId)));
  return { actions: rows.map(toAction), idByKey: new Map(rows.map((r) => [r.actionKey, r.id])) };
}

async function assembleRecord(
  db: Db,
  api: ApiRow,
  specVersionId: string,
): Promise<ImportRecord | null> {
  // One round trip, not two: both reads depend only on ids already in hand.
  // Against Neon over HTTP every sequential await is a network hop, and this
  // function sits under every MCP tool call and every product page render.
  const [[specVersion], { actions: actionsList }] = await Promise.all([
    db.select().from(specVersions).where(eq(specVersions.id, specVersionId)).limit(1),
    loadActionsForVersion(db, api.id, specVersionId),
  ]);
  const counts = { total: actionsList.length, read: 0, write: 0, destructive: 0 };
  for (const a of actionsList) counts[a.safety]++;

  return {
    id: api.slug,
    name: api.name,
    source: (specVersion?.source as ImportSource) ?? 'openapi',
    sourceUrl: specVersion?.sourceUrl ?? undefined,
    ...(Array.isArray(specVersion?.webhooks) && (specVersion.webhooks as Webhook[]).length
      ? { webhooks: specVersion.webhooks as Webhook[] }
      : {}),
    baseUrls: (api.baseUrls as string[] | null) ?? [],
    auth: api.dominantAuth as ImportRecord['auth'],
    authIn: (api.authIn as ImportRecord['authIn']) ?? undefined,
    actions: actionsList,
    counts,
    // Carried so lineage.ts can cache the computed graph across requests: this
    // function returns a FRESH object literal every call, so the object-identity
    // memo in lineage.ts can never hit for a persisted API.
    specVersionId,
    createdAt: api.createdAt.getTime(),
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
}

// Loads a persistent API by slug and reshapes it into the same ImportRecord
// shape Phase 0's ephemeral records use, so every existing renderer
// (ActionCard, AuthGuide, McpBlock, Playground, ScorePreviewPanel), the
// playground proxy, and the MCP handler work unchanged against either
// storage. `expiresAt` is set to Number.MAX_SAFE_INTEGER — persistent
// records never expire.
// `db` is optional so the pglite tests can hand in their own connection; the
// production callers keep getting the shared Neon handle.
export async function loadPersistentRecord(slug: string, db?: Db): Promise<ImportRecord | null> {
  const conn = db ?? (dbReady() ? getDb() : null);
  if (!conn) return null;

  const [api] = await conn.select().from(apis).where(eq(apis.slug, slug)).limit(1);
  if (!api || !api.currentSpecVersionId) return null;

  return assembleRecord(conn, api, api.currentSpecVersionId);
}

// Same shape as loadPersistentRecord, but by (apiId, specVersionId) rather
// than slug — for background jobs (the deep-analysis chain) that only ever
// have ids, and that may need a specific version rather than "whichever is
// current" (a re-import could complete while an older version's analysis is
// still in flight).
export async function loadRecordForVersion(apiId: string, specVersionId: string): Promise<ImportRecord | null> {
  if (!dbReady()) return null;
  const db = getDb();

  const [api] = await db.select().from(apis).where(eq(apis.id, apiId)).limit(1);
  if (!api) return null;

  return assembleRecord(db, api, specVersionId);
}

// Claim status + live-verified score, kept separate from ImportRecord (which
// every renderer already agrees on) since only [slug]/page.tsx and the
// dashboard need this. Flat select (not nested table objects) to sidestep
// leftJoin-with-no-match typing, matching badge/[slug]/route.ts.
export async function loadApiVerificationState(slug: string): Promise<ApiVerificationState | null> {
  if (!dbReady()) return null;
  const db = getDb();

  const [row] = await db
    .select({
      apiId: apis.id,
      name: apis.name,
      orgId: apis.orgId,
      claimStatus: apis.claimStatus,
      analysisStatus: apis.analysisStatus,
      currentSpecVersionId: apis.currentSpecVersionId,
      total: scores.total,
      authClarity: scores.authClarity,
      errorQuality: scores.errorQuality,
      docDrift: scores.docDrift,
      idempotency: scores.idempotency,
      explanation: scores.explanation,
      scoreSpecVersionId: scores.specVersionId,
      verifiedAt: scores.verifiedAt,
      liveCallsAttempted: scores.liveCallsAttempted,
      liveCallsSucceeded: scores.liveCallsSucceeded,
    })
    .from(apis)
    .leftJoin(scores, eq(scores.apiId, apis.id))
    .where(eq(apis.slug, slug))
    .limit(1);
  if (!row) return null;

  return {
    apiId: row.apiId,
    name: row.name,
    orgId: row.orgId,
    claimStatus: row.claimStatus,
    analysisStatus: row.analysisStatus,
    currentSpecVersionId: row.currentSpecVersionId,
    scores:
      row.total == null
        ? null
        : {
            total: row.total,
            authClarity: row.authClarity!,
            errorQuality: row.errorQuality,
            docDrift: row.docDrift,
            idempotency: row.idempotency!,
            explanation: (row.explanation as { factId: string; message: string }[] | null) ?? [],
            stale: row.scoreSpecVersionId !== row.currentSpecVersionId,
            verifiedAt: row.verifiedAt!.toISOString(),
            specVersionId: row.scoreSpecVersionId!,
            liveCallsAttempted: row.liveCallsAttempted ?? 0,
            liveCallsSucceeded: row.liveCallsSucceeded ?? 0,
          },
  };
}

// Batched "Verified ✓" lookup for the dashboard list — one query per org
// view rather than one per row. A score fenced to a superseded spec version
// does not count: the dashboard chip would otherwise keep saying "verified"
// after a re-import changed the contract.
export async function loadVerifiedApiIds(apiIds: string[]): Promise<Set<string>> {
  if (!dbReady() || !apiIds.length) return new Set();
  const db = getDb();
  const rows = await db
    .select({ apiId: scores.apiId })
    .from(scores)
    .innerJoin(apis, eq(apis.id, scores.apiId))
    .where(and(inArray(scores.apiId, apiIds), eq(scores.specVersionId, apis.currentSpecVersionId)));
  return new Set(rows.map((r) => r.apiId));
}
