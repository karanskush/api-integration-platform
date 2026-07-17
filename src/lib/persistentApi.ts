import { and, eq } from 'drizzle-orm';
import { dbReady, getDb } from './db';
import { actions as actionsTable, apis, specVersions } from './db/schema';
import type { Action, ImportRecord, ImportSource } from './ir';

function toAction(row: typeof actionsTable.$inferSelect): Action {
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
  };
}

// Loads a persistent API by slug and reshapes it into the same ImportRecord
// shape Phase 0's ephemeral records use, so every existing renderer
// (ActionCard, AuthGuide, McpBlock, Playground, ScorePreviewPanel), the
// playground proxy, and the MCP handler work unchanged against either
// storage. `expiresAt` is set to Number.MAX_SAFE_INTEGER — persistent
// records never expire.
export async function loadPersistentRecord(slug: string): Promise<ImportRecord | null> {
  if (!dbReady()) return null;
  const db = getDb();

  const [api] = await db.select().from(apis).where(eq(apis.slug, slug)).limit(1);
  if (!api || !api.currentSpecVersionId) return null;

  const [specVersion] = await db
    .select()
    .from(specVersions)
    .where(eq(specVersions.id, api.currentSpecVersionId))
    .limit(1);
  const rows = await db
    .select()
    .from(actionsTable)
    .where(and(eq(actionsTable.apiId, api.id), eq(actionsTable.specVersionId, api.currentSpecVersionId)));

  const actionsList = rows.map(toAction);
  const counts = { total: actionsList.length, read: 0, write: 0, destructive: 0 };
  for (const a of actionsList) counts[a.safety]++;

  return {
    id: api.slug,
    name: api.name,
    source: (specVersion?.source as ImportSource) ?? 'openapi',
    sourceUrl: specVersion?.sourceUrl ?? undefined,
    baseUrls: (api.baseUrls as string[] | null) ?? [],
    auth: api.dominantAuth as ImportRecord['auth'],
    authIn: (api.authIn as ImportRecord['authIn']) ?? undefined,
    actions: actionsList,
    counts,
    createdAt: api.createdAt.getTime(),
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
}
