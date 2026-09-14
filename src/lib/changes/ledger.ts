// The change ledger: api_changes rows, closed over the same kind/severity
// vocabulary the diff engine emits, validated the way evidence.ts validates
// evidence_facts — the DB columns stay open text, TypeScript and zod close them.
//
// Two write paths, both returning Drizzle statements rather than executing
// them, so the caller can fold them into one neon-http `db.batch()` (see
// persist.ts's header for why) and tests can run them one at a time on pglite:
//
//   buildChangeStatements          — spec-diff rows between two versions,
//                                    written by the reimport path.
//   buildLifecycleChangeStatements — header-observed rows (Deprecation /
//                                    Sunset seen on a live response), written
//                                    by the score run. Deduplicated by the
//                                    partial unique index on (api_id,
//                                    dedupe_key), so the same Sunset date seen
//                                    on every probe run stays one row.

import { randomUUID } from 'node:crypto';
import type { BatchItem } from 'drizzle-orm/batch';
import { z } from 'zod';
import type { Db } from '../db';
import { apiChanges } from '../db/schema';
import { CHANGE_KINDS, SEVERITIES, type Change, type ChangeKind, type Severity } from './diff';
import { lifecycleChangeKind, type LifecycleSignal } from './lifecycle';

export const CHANGE_SOURCES = ['ci_push', 'poll', 'manual', 'reverify', 'header', 'probe'] as const;

export type ChangeSource = (typeof CHANGE_SOURCES)[number];

export type ChangeRow = {
  id: string;
  kind: ChangeKind;
  severity: Severity;
  source: ChangeSource;
  actionKey: string | null;
  tool: string | null;
  method: string | null;
  path: string | null;
  fieldPath: string | null;
  location: string | null;
  summary: string;
  detail: Record<string, unknown>;
  fromSpecVersionId: string | null;
  toSpecVersionId: string | null;
  // Joined from spec_versions by the query layer; absent on a bare row.
  toContentHash?: string | null;
  observedAt: string; // ISO
};

const changeRowSchema = z.object({
  id: z.string(),
  kind: z.enum(CHANGE_KINDS),
  severity: z.enum(SEVERITIES as [Severity, ...Severity[]]),
  source: z.enum(CHANGE_SOURCES),
  actionKey: z.string().nullable(),
  tool: z.string().nullable(),
  method: z.string().nullable(),
  path: z.string().nullable(),
  fieldPath: z.string().nullable(),
  location: z.string().nullable(),
  summary: z.string(),
  detail: z.record(z.string(), z.unknown()),
  fromSpecVersionId: z.string().nullable(),
  toSpecVersionId: z.string().nullable(),
  toContentHash: z.string().nullable().optional(),
  observedAt: z.string(),
});

type DbRow = typeof apiChanges.$inferSelect & { toContentHash?: string | null };

// Never throws: a row written by a future kind this build does not know is
// skipped, not fatal, on the MCP hot path.
export function parseChangeRow(row: DbRow): ChangeRow | null {
  const result = changeRowSchema.safeParse({
    ...row,
    detail: row.detail ?? {},
    observedAt: row.observedAt instanceof Date ? row.observedAt.toISOString() : row.observedAt,
  });
  return result.success ? (result.data as ChangeRow) : null;
}

// Bounds on what one row may carry. `detail` holds before/after for scalars
// and enum lists — never a schema — so a 500-row insert stays a few hundred KB
// and well inside neon-http's single-request batch.
const MAX_SUMMARY_CHARS = 500;
const MAX_DETAIL_VALUE_CHARS = 2048;
// Field paths are built by concatenating property NAMES from a third-party
// spec, and nothing upstream caps the length of one name — only how many
// fields are walked. Capped here for the same reason summary is: these strings
// are re-served on the public JSON API and to agents.
const MAX_PATH_CHARS = 300;

function capValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  const text = JSON.stringify(value);
  if (text === undefined) return undefined;
  return text.length > MAX_DETAIL_VALUE_CHARS ? `${text.slice(0, MAX_DETAIL_VALUE_CHARS - 1)}…` : value;
}

function capSummary(summary: string): string {
  return summary.length > MAX_SUMMARY_CHARS ? `${summary.slice(0, MAX_SUMMARY_CHARS - 1)}…` : summary;
}

function capPath(value: string | undefined | null): string | null {
  if (!value) return null;
  return value.length > MAX_PATH_CHARS ? `${value.slice(0, MAX_PATH_CHARS - 1)}…` : value;
}

export type ChangeStatementsInput = {
  apiId: string;
  fromSpecVersionId: string | null;
  toSpecVersionId: string | null;
  source: ChangeSource;
  changes: Change[];
  // action_key → actions.id for the NEW version (changed and added operations)
  // and for the PREVIOUS version (removed operations). Either may be omitted;
  // rows then carry action_key only, which the changelog can still render.
  actionIdByKey?: Map<string, string>;
  removedActionIdByKey?: Map<string, string>;
  observedAt?: Date;
};

export function buildChangeStatements(
  db: Db,
  input: ChangeStatementsInput,
): { statements: BatchItem<'pg'>[]; changeIds: string[] } {
  if (!input.changes.length) return { statements: [], changeIds: [] };
  const observedAt = input.observedAt ?? new Date();
  const changeIds = input.changes.map(() => randomUUID());

  const rows = input.changes.map((c, i) => {
    const actionId =
      c.actionKey === undefined
        ? null
        : c.kind === 'operation.removed'
          ? (input.removedActionIdByKey?.get(c.actionKey) ?? null)
          : (input.actionIdByKey?.get(c.actionKey) ?? null);
    const detail: Record<string, unknown> = {};
    const before = capValue(c.before);
    const after = capValue(c.after);
    if (before !== undefined) detail.before = before;
    if (after !== undefined) detail.after = after;
    return {
      id: changeIds[i],
      apiId: input.apiId,
      fromSpecVersionId: input.fromSpecVersionId,
      toSpecVersionId: input.toSpecVersionId,
      actionId,
      actionKey: c.actionKey ?? null,
      tool: capPath(c.tool),
      method: c.method ?? null,
      path: capPath(c.path),
      kind: c.kind,
      severity: c.severity,
      source: input.source,
      fieldPath: capPath(c.fieldPath),
      location: c.location ?? null,
      summary: capSummary(c.summary),
      detail,
      dedupeKey: null,
      observedAt,
    };
  });

  return { statements: [db.insert(apiChanges).values(rows)], changeIds };
}

// `value` is the date when the header carried one, else the raw header text —
// so a moved Sunset date is a NEW row (the provider changed the announcement)
// while the same date on the next probe run is not.
export function lifecycleDedupeKey(actionKey: string, kind: ChangeKind, value: string): string {
  return `header:${actionKey}:${kind}:${value}`;
}

export type LifecycleFactInput = {
  actionKey: string;
  tool: string;
  method: string;
  path: string;
  signal: LifecycleSignal;
};

export function buildLifecycleChangeStatements(
  db: Db,
  input: { apiId: string; specVersionId: string; facts: LifecycleFactInput[]; actionIdByKey?: Map<string, string>; observedAt?: Date },
): BatchItem<'pg'>[] {
  const observedAt = input.observedAt ?? new Date();
  const seen = new Set<string>();
  const rows: (typeof apiChanges.$inferInsert)[] = [];

  for (const fact of input.facts) {
    const kind = lifecycleChangeKind(fact.signal);
    if (!kind) continue;
    const value = fact.signal.at ?? fact.signal.raw;
    const dedupeKey = lifecycleDedupeKey(fact.actionKey, kind, value);
    // The unique index also catches this, but a duplicate inside one INSERT
    // is cheaper to drop here than to rely on ON CONFLICT semantics for.
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const label = `${fact.tool} (${fact.method} ${fact.path})`;
    const summary =
      kind === 'operation.sunset_scheduled'
        ? `${label}: provider announces sunset${fact.signal.at ? ` at ${fact.signal.at}` : ''} via ${fact.signal.header} header`
        : `${label}: provider signals deprecation via ${fact.signal.header} header${fact.signal.at ? ` (since ${fact.signal.at})` : ''}`;

    rows.push({
      id: randomUUID(),
      apiId: input.apiId,
      fromSpecVersionId: null,
      toSpecVersionId: input.specVersionId,
      actionId: input.actionIdByKey?.get(fact.actionKey) ?? null,
      actionKey: fact.actionKey,
      tool: capPath(fact.tool),
      method: fact.method,
      path: capPath(fact.path),
      kind,
      severity: 'risky',
      source: 'header',
      fieldPath: null,
      location: null,
      summary: capSummary(summary),
      detail: {
        header: fact.signal.header,
        raw: capValue(fact.signal.raw),
        ...(fact.signal.at ? { at: fact.signal.at } : {}),
        ...(fact.signal.url ? { url: capValue(fact.signal.url) } : {}),
      },
      dedupeKey,
      observedAt,
    });
  }

  if (!rows.length) return [];
  return [db.insert(apiChanges).values(rows).onConflictDoNothing()];
}
