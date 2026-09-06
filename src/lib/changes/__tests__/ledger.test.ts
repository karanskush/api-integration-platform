import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../db/schema';
import { createTestDb, type TestDb } from '../../db/__tests__/testDb';
import type { Change } from '../diff';
import { buildChangeStatements, buildLifecycleChangeStatements, lifecycleDedupeKey, parseChangeRow } from '../ledger';
import type { LifecycleSignal } from '../lifecycle';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
}, 30_000);

let seq = 0;
async function seedApi() {
  seq += 1;
  const [org] = await db.insert(schema.orgs).values({ name: `Ledger Org ${seq}`, slug: `ledger-org-${seq}` }).returning();
  const [api] = await db.insert(schema.apis).values({ orgId: org.id, slug: `ledger-api-${seq}`, name: `Ledger API ${seq}` }).returning();
  const [version] = await db
    .insert(schema.specVersions)
    .values({ apiId: api.id, source: 'openapi', contentHash: `ledger-hash-${seq}`, parseStatus: 'parsed' })
    .returning();
  return { apiId: api.id, specVersionId: version.id };
}

async function addAction(apiId: string, specVersionId: string, actionKey: string) {
  const [row] = await db
    .insert(schema.actions)
    .values({
      apiId,
      specVersionId,
      actionKey,
      name: `tool_${actionKey}`,
      description: 'x',
      method: 'GET',
      path: `/${actionKey}`,
      paramsSchema: { type: 'object', properties: {} },
      auth: 'none',
      safety: 'read',
    })
    .returning();
  return row.id;
}

async function run(statements: unknown[]) {
  for (const statement of statements) await statement;
}

function rowsFor(apiId: string) {
  return db.select().from(schema.apiChanges).where(eq(schema.apiChanges.apiId, apiId));
}

function change(overrides: Partial<Change> = {}): Change {
  return {
    kind: 'field.removed',
    severity: 'breaking',
    actionKey: 'a1',
    tool: 'get_thing',
    method: 'GET',
    path: '/things',
    fieldPath: 'response.name',
    location: 'response',
    before: 'string',
    summary: 'get_thing response field response.name removed',
    ...overrides,
  };
}

function signal(overrides: Partial<LifecycleSignal> = {}): LifecycleSignal {
  return { kind: 'sunset', header: 'sunset', raw: 'Wed, 30 Jun 2027 23:59:59 GMT', at: '2027-06-30T23:59:59.000Z', ...overrides };
}

describe('buildChangeStatements', () => {
  // Drizzle throws on values([]), so an empty diff must produce no statement
  // rather than an empty insert.
  it('emits nothing at all for an empty change list', () => {
    const built = buildChangeStatements(db, {
      apiId: 'x',
      fromSpecVersionId: null,
      toSpecVersionId: null,
      source: 'manual',
      changes: [],
    });
    expect(built.statements).toEqual([]);
    expect(built.changeIds).toEqual([]);
  });

  it('writes one row per change with its version fence and source', async () => {
    const { apiId, specVersionId } = await seedApi();
    const built = buildChangeStatements(db, {
      apiId,
      fromSpecVersionId: null,
      toSpecVersionId: specVersionId,
      source: 'ci_push',
      changes: [change(), change({ kind: 'operation.added', severity: 'additive', fieldPath: undefined, location: undefined, before: undefined, summary: 'added' })],
    });
    await run(built.statements);

    const rows = await rowsFor(apiId);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.source === 'ci_push' && r.toSpecVersionId === specVersionId && r.fromSpecVersionId === null)).toBe(true);
    expect(rows.map((r) => r.id).sort()).toEqual([...built.changeIds].sort());

    const removed = rows.find((r) => r.kind === 'field.removed')!;
    expect(removed).toMatchObject({ severity: 'breaking', fieldPath: 'response.name', location: 'response', dedupeKey: null });
    expect(removed.detail).toEqual({ before: 'string' });
    // No before/after on the added row: the key is omitted, not stored as null.
    expect(rows.find((r) => r.kind === 'operation.added')!.detail).toEqual({});
  });

  // A removed operation has no row in the NEW version, so its change must
  // reference the previous version's row or the changelog loses the link.
  it('points a removed operation at the previous version row and a changed one at the new row', async () => {
    const { apiId, specVersionId } = await seedApi();
    const [older] = await db
      .insert(schema.specVersions)
      .values({ apiId, source: 'openapi', contentHash: `older-${seq}`, parseStatus: 'parsed' })
      .returning();
    const oldRowId = await addAction(apiId, older.id, 'a1');
    const newRowId = await addAction(apiId, specVersionId, 'a1');

    const built = buildChangeStatements(db, {
      apiId,
      fromSpecVersionId: older.id,
      toSpecVersionId: specVersionId,
      source: 'poll',
      changes: [
        change({ kind: 'operation.removed', fieldPath: undefined, location: undefined, summary: 'removed' }),
        change({ kind: 'field.type_changed', summary: 'type changed' }),
      ],
      actionIdByKey: new Map([['a1', newRowId]]),
      removedActionIdByKey: new Map([['a1', oldRowId]]),
    });
    await run(built.statements);

    const rows = await rowsFor(apiId);
    expect(rows.find((r) => r.kind === 'operation.removed')!.actionId).toBe(oldRowId);
    expect(rows.find((r) => r.kind === 'field.type_changed')!.actionId).toBe(newRowId);
  });

  it('still writes the row, keyed by action_key, when no id map is supplied', async () => {
    const { apiId, specVersionId } = await seedApi();
    await run(
      buildChangeStatements(db, {
        apiId,
        fromSpecVersionId: null,
        toSpecVersionId: specVersionId,
        source: 'manual',
        changes: [change()],
      }).statements,
    );

    const [row] = await rowsFor(apiId);
    expect(row.actionId).toBeNull();
    expect(row.actionKey).toBe('a1');
    expect(row.tool).toBe('get_thing');
  });

  it('caps an oversized summary and detail value instead of storing a novel', async () => {
    const { apiId, specVersionId } = await seedApi();
    const huge = 'x'.repeat(5000);
    await run(
      buildChangeStatements(db, {
        apiId,
        fromSpecVersionId: null,
        toSpecVersionId: specVersionId,
        source: 'manual',
        changes: [change({ before: huge, summary: huge })],
      }).statements,
    );

    const [row] = await rowsFor(apiId);
    expect(row.summary.length).toBeLessThanOrEqual(500);
    expect(String((row.detail as { before: string }).before).length).toBeLessThanOrEqual(2048);
  });
});

describe('buildLifecycleChangeStatements', () => {
  it('collapses a repeated observation of the same sunset date to one row', async () => {
    const { apiId, specVersionId } = await seedApi();
    const facts = [{ actionKey: 'a1', tool: 'get_thing', method: 'GET', path: '/things', signal: signal() }];

    await run(buildLifecycleChangeStatements(db, { apiId, specVersionId, facts }));
    await run(buildLifecycleChangeStatements(db, { apiId, specVersionId, facts }));

    const rows = await rowsFor(apiId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'header', severity: 'risky', kind: 'operation.sunset_scheduled' });
    expect(rows[0].dedupeKey).toBe(lifecycleDedupeKey('a1', 'operation.sunset_scheduled', '2027-06-30T23:59:59.000Z'));
    expect(rows[0].detail).toMatchObject({ header: 'sunset', at: '2027-06-30T23:59:59.000Z' });
  });

  it('records a second row when the provider moves the sunset date', async () => {
    const { apiId, specVersionId } = await seedApi();
    const base = { actionKey: 'a1', tool: 'get_thing', method: 'GET', path: '/things' };
    await run(buildLifecycleChangeStatements(db, { apiId, specVersionId, facts: [{ ...base, signal: signal() }] }));
    await run(
      buildLifecycleChangeStatements(db, {
        apiId,
        specVersionId,
        facts: [{ ...base, signal: signal({ at: '2028-01-01T00:00:00.000Z', raw: 'Sat, 01 Jan 2028 00:00:00 GMT' }) }],
      }),
    );

    expect(await rowsFor(apiId)).toHaveLength(2);
  });

  it('deduplicates within a single call, so two probes seeing one header write one row', async () => {
    const { apiId, specVersionId } = await seedApi();
    const fact = { actionKey: 'a1', tool: 'get_thing', method: 'GET', path: '/things', signal: signal() };
    await run(buildLifecycleChangeStatements(db, { apiId, specVersionId, facts: [fact, { ...fact }] }));
    expect(await rowsFor(apiId)).toHaveLength(1);
  });

  it('writes a deprecation row for the Deprecation header and vendor equivalents', async () => {
    const { apiId, specVersionId } = await seedApi();
    await run(
      buildLifecycleChangeStatements(db, {
        apiId,
        specVersionId,
        facts: [
          { actionKey: 'a1', tool: 't1', method: 'GET', path: '/a', signal: { kind: 'deprecated', header: 'deprecation', raw: '@1788000000', at: '2026-08-29T04:00:00.000Z' } },
          { actionKey: 'a2', tool: 't2', method: 'GET', path: '/b', signal: { kind: 'vendor_deprecation', header: 'x-shopify-api-deprecated-reason', raw: 'https://shopify.dev/changelog' } },
        ],
      }),
    );

    const rows = await rowsFor(apiId);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.kind === 'operation.deprecated')).toBe(true);
  });

  it('ignores signals that are evidence but not changes', () => {
    const statements = buildLifecycleChangeStatements(db, {
      apiId: 'x',
      specVersionId: 'v',
      facts: [
        { actionKey: 'a1', tool: 't', method: 'GET', path: '/p', signal: { kind: 'version', header: 'stripe-version', raw: '2026-04-22' } },
        { actionKey: 'a1', tool: 't', method: 'GET', path: '/p', signal: { kind: 'successor', header: 'link', raw: '<x>; rel="successor-version"', url: 'https://x' } },
      ],
    });
    expect(statements).toEqual([]);
  });
});

describe('parseChangeRow', () => {
  const base = {
    id: 'id-1',
    apiId: 'api-1',
    fromSpecVersionId: null,
    toSpecVersionId: 'v2',
    actionId: null,
    actionKey: 'a1',
    tool: 'get_thing',
    method: 'GET',
    path: '/things',
    kind: 'field.removed',
    severity: 'breaking',
    source: 'poll',
    fieldPath: 'response.name',
    location: 'response',
    summary: 'gone',
    detail: { before: 'string' },
    dedupeKey: null,
    observedAt: new Date('2026-09-01T00:00:00.000Z'),
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
  };

  it('parses a well-formed row and normalizes the timestamp to ISO', () => {
    expect(parseChangeRow(base as never)).toMatchObject({
      kind: 'field.removed',
      severity: 'breaking',
      source: 'poll',
      observedAt: '2026-09-01T00:00:00.000Z',
    });
  });

  it('defaults a null detail to an empty object rather than failing', () => {
    expect(parseChangeRow({ ...base, detail: null } as never)?.detail).toEqual({});
  });

  // A row written by a future build's vocabulary must not break the MCP hot
  // path; it is skipped, the way parseEvidencePayload degrades to null.
  it('returns null for a kind, severity, or source this build does not know', () => {
    expect(parseChangeRow({ ...base, kind: 'operation.teleported' } as never)).toBeNull();
    expect(parseChangeRow({ ...base, severity: 'catastrophic' } as never)).toBeNull();
    expect(parseChangeRow({ ...base, source: 'telepathy' } as never)).toBeNull();
  });
});

describe('path capping', () => {
  // Field paths concatenate property NAMES from a third-party spec, and
  // nothing upstream caps the length of one name — only how many are walked.
  it('caps an absurdly long field path, tool, and path before storing them', async () => {
    const { apiId, specVersionId } = await seedApi();
    const huge = 'x'.repeat(5000);
    await run(
      buildChangeStatements(db, {
        apiId,
        fromSpecVersionId: null,
        toSpecVersionId: specVersionId,
        source: 'poll',
        changes: [change({ fieldPath: `body.${huge}`, tool: huge, path: `/${huge}` })],
      }).statements,
    );

    const [row] = await rowsFor(apiId);
    expect(row.fieldPath!.length).toBeLessThanOrEqual(300);
    expect(row.tool!.length).toBeLessThanOrEqual(300);
    expect(row.path!.length).toBeLessThanOrEqual(300);
  });
});
