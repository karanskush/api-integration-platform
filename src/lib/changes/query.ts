// Read side of the change ledger: what the changelog page, the feeds, the
// freshness strip, the badge manifest, and the MCP advisor tools all read.
//
// Every function takes an explicit `db` rather than calling getDb(), so the
// same code serves a route handler, a server component, and a pglite test.

import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { apiChanges, apis, specVersions } from '../db/schema';
import { SEVERITIES, type Severity } from './diff';
import { parseChangeRow, type ChangeRow, type ChangeSource } from './ledger';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

// The change ledger is ADDITIVE to surfaces that already worked without it:
// the API page rendered fine before there was a changelog. So a ledger read
// must never be able to take one of those pages down — most concretely when
// code deploys ahead of migration 0009 and `api_changes` does not exist yet,
// which would otherwise 500 every API page at once.
//
// Deliberately narrow: this degrades a MISSING ledger to an empty one and logs
// the error name. It is the same "degrade cleanly, never fail the caller"
// contract specStore.ts and replay.ts already follow, and the reason it is
// safe here is that an empty changelog is honest — the page says "no changes
// recorded", which is exactly true when the table does not exist.
async function degradeToEmpty<T>(
  label: string,
  fallback: T,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (err) {
    console.error(`[changes] ${label} unavailable`, {
      reason: err instanceof Error ? err.name : 'unknown',
    });
    return fallback;
  }
}

export type ListChangesOptions = {
  limit?: number;
  since?: Date;
  severity?: Severity;
};

export async function listChanges(
  db: Db,
  apiId: string,
  opts: ListChangesOptions = {},
): Promise<ChangeRow[]> {
  const limit = Math.max(1, Math.min(MAX_LIMIT, opts.limit ?? DEFAULT_LIMIT));

  return degradeToEmpty('listChanges', [], async () => {
    const rows = await db
      .select({
        row: apiChanges,
        toContentHash: specVersions.contentHash,
      })
      .from(apiChanges)
      .leftJoin(specVersions, eq(specVersions.id, apiChanges.toSpecVersionId))
      .where(
        and(
          eq(apiChanges.apiId, apiId),
          ...(opts.since ? [gte(apiChanges.observedAt, opts.since)] : []),
          ...(opts.severity ? [eq(apiChanges.severity, opts.severity)] : []),
        ),
      )
      // id is the tiebreaker so a page boundary inside one release is stable.
      .orderBy(desc(apiChanges.observedAt), desc(apiChanges.id))
      .limit(limit);

    // parseChangeRow drops a row written by a vocabulary this build does not
    // know rather than throwing on the hot path.
    return rows
      .map((r) => parseChangeRow({ ...r.row, toContentHash: r.toContentHash }))
      .filter((r): r is ChangeRow => r !== null);
  });
}

export function emptySeverityCounts(): Record<Severity, number> {
  return { breaking: 0, risky: 0, additive: 0, cosmetic: 0 };
}

export type ChangeSummary = {
  counts30d: Record<Severity, number>;
  total30d: number;
  lastChangeAt: string | null;
  // When we last confirmed the spec was still what we think it is — a poll
  // that returned 304 counts, because "checked, unchanged" is the answer the
  // freshness line needs. Falls back to when the version was recorded.
  lastCheckedAt: string | null;
  lastSpecChangeAt: string | null;
  currentSpecVersionId: string | null;
  currentVersionHash: string | null;
};

export function emptySummary(): ChangeSummary {
  return {
    counts30d: emptySeverityCounts(),
    total30d: 0,
    lastChangeAt: null,
    lastCheckedAt: null,
    lastSpecChangeAt: null,
    currentSpecVersionId: null,
    currentVersionHash: null,
  };
}

export async function changeSummary(
  db: Db,
  apiId: string,
  now = new Date(),
): Promise<ChangeSummary> {
  return degradeToEmpty('changeSummary', emptySummary(), () =>
    readChangeSummary(db, apiId, now),
  );
}

async function readChangeSummary(
  db: Db,
  apiId: string,
  now: Date,
): Promise<ChangeSummary> {
  const since = new Date(now.getTime() - 30 * 24 * 3600 * 1000);

  const [countRows, [latest], [current], [firstVersion]] = await Promise.all([
    db
      .select({
        severity: apiChanges.severity,
        count: sql<number>`count(*)::int`,
      })
      .from(apiChanges)
      .where(
        and(eq(apiChanges.apiId, apiId), gte(apiChanges.observedAt, since)),
      )
      .groupBy(apiChanges.severity),
    db
      .select({ observedAt: apiChanges.observedAt })
      .from(apiChanges)
      .where(eq(apiChanges.apiId, apiId))
      .orderBy(desc(apiChanges.observedAt))
      .limit(1),
    db
      .select({
        specVersionId: specVersions.id,
        contentHash: specVersions.contentHash,
        lastPolledAt: specVersions.lastPolledAt,
        createdAt: specVersions.createdAt,
      })
      .from(apis)
      .innerJoin(specVersions, eq(specVersions.id, apis.currentSpecVersionId))
      .where(eq(apis.id, apiId))
      .limit(1),
    db
      .select({ id: specVersions.id, createdAt: specVersions.createdAt })
      .from(specVersions)
      .where(eq(specVersions.apiId, apiId))
      .orderBy(specVersions.createdAt, specVersions.id)
      .limit(1),
  ]);

  const counts30d = emptySeverityCounts();
  for (const row of countRows) {
    if ((SEVERITIES as readonly string[]).includes(row.severity))
      counts30d[row.severity as Severity] = Number(row.count);
  }

  // The first version is the import, not a change — an API with one version
  // has never changed, however long ago it was imported. Compared by identity
  // rather than timestamp: two versions can share a timestamp, and a reverted
  // API's current version is an OLD row whose date says nothing about when the
  // revert happened.
  const lastSpecChangeAt =
    current && firstVersion && current.specVersionId !== firstVersion.id
      ? current.createdAt.toISOString()
      : null;

  const lastChecked = current
    ? (current.lastPolledAt ?? current.createdAt)
    : null;

  return {
    counts30d,
    total30d: Object.values(counts30d).reduce((sum, n) => sum + n, 0),
    lastChangeAt: latest?.observedAt?.toISOString() ?? null,
    lastCheckedAt: lastChecked?.toISOString() ?? null,
    lastSpecChangeAt,
    currentSpecVersionId: current?.specVersionId ?? null,
    currentVersionHash: current?.contentHash ?? null,
  };
}

const HASH_PREFIX = /^[0-9a-f]{6,64}$/i;

// `since` accepts an ISO timestamp or a spec-version content-hash prefix, so a
// consumer can ask "what changed since the version I integrated against"
// without having to know when they integrated.
export async function resolveSince(
  db: Db,
  apiId: string,
  raw: string,
): Promise<Date | null> {
  const value = raw.trim();
  if (!value) return null;

  if (HASH_PREFIX.test(value)) {
    return degradeToEmpty('resolveSince', null, async () => {
      const [row] = await db
        .select({ createdAt: specVersions.createdAt })
        .from(specVersions)
        .where(
          and(
            eq(specVersions.apiId, apiId),
            sql`${specVersions.contentHash} like ${`${value.toLowerCase()}%`}`,
          ),
        )
        .orderBy(desc(specVersions.createdAt))
        .limit(1);
      return row?.createdAt ?? null;
    });
  }

  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at) : null;
}

export type Release = {
  key: string;
  observedAt: string;
  specVersionHash: string | null;
  sources: ChangeSource[];
  counts: Record<Severity, number>;
  changes: ChangeRow[];
};

// Groups rows into the units a reader thinks in: one spec version's diff is
// one release. Header- and probe-observed rows belong to no version diff, so
// they group by the UTC day they were seen.
export function groupIntoReleases(rows: ChangeRow[]): Release[] {
  const groups = new Map<string, ChangeRow[]>();
  for (const row of rows) {
    const key =
      row.toSpecVersionId ?? `observed:${row.observedAt.slice(0, 10)}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  return [...groups.entries()].map(([key, changes]) => {
    const counts = emptySeverityCounts();
    for (const c of changes) counts[c.severity]++;
    return {
      key,
      // The rows arrive newest-first, so the first is the group's timestamp.
      observedAt: changes[0].observedAt,
      specVersionHash:
        changes.find((c) => c.toContentHash)?.toContentHash ?? null,
      sources: [...new Set(changes.map((c) => c.source))],
      counts,
      changes,
    };
  });
}

// Batched "does this API have changes" lookup, for a future dashboard column —
// kept here so the dashboard never opens a second query path onto the ledger.
export async function countChangesSince(
  db: Db,
  apiIds: string[],
  since: Date,
): Promise<Map<string, number>> {
  if (!apiIds.length) return new Map();
  return degradeToEmpty(
    'countChangesSince',
    new Map<string, number>(),
    async () => {
      const rows = await db
        .select({ apiId: apiChanges.apiId, count: sql<number>`count(*)::int` })
        .from(apiChanges)
        .where(
          and(
            inArray(apiChanges.apiId, apiIds),
            gte(apiChanges.observedAt, since),
          ),
        )
        .groupBy(apiChanges.apiId);
      return new Map(rows.map((r) => [r.apiId, Number(r.count)]));
    },
  );
}
