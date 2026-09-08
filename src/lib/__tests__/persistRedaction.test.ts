// Database-level containment for the import secret filter.
//
// secretScan.test.ts proves the classifier works and importSecrets.test.ts
// proves nothing leaks into a PUBLISHED surface. This file closes the third
// gap: that recording the redaction does not itself become a second copy of the
// secret, and that a cURL carrying a credential is not published by default.
//
// The central assertion is a whole-database scan rather than a targeted column
// check. That generalizes for free as columns are added, which is the property
// "structurally enforced" has to mean to be worth anything.

import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { createTestDb, type TestDb } from '../db/__tests__/testDb';
import { curlToOpenApi } from '../importer/curl';
import type { ImportRecord } from '../ir';
import { normalizeOpenApi } from '../normalize';
import { buildPersistStatements } from '../persist';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
}, 30_000);

// Assembled from parts, not written inline — see the note in
// importSecrets.test.ts. GitHub's push protection flags the literal form,
// correctly.
const k = (...parts: string[]) => parts.join('');
const SENTINEL = k('sk', '_live_', '51SENTINELAbCdEfGhIjKlMnOpQr');
const GITLAB_TOKEN = k('glpat', '-', 'ABCdefGHIjklMNOpqrs');

let seq = 0;
async function makeOrg() {
  seq += 1;
  const [org] = await db
    .insert(schema.orgs)
    .values({ name: `Redaction Org ${seq}`, slug: `redaction-org-${seq}` })
    .returning();
  return org;
}

function curlRecord(command: string, overrides: Partial<ImportRecord> = {}): ImportRecord {
  const spec = normalizeOpenApi(curlToOpenApi(command));
  return {
    id: `eph-${seq}`,
    name: spec.name,
    source: 'curl',
    baseUrls: ['https://api.example.com'],
    auth: spec.auth,
    authIn: spec.authIn,
    actions: spec.actions,
    ...(spec.redactions.length ? { redactions: spec.redactions } : {}),
    counts: { total: spec.actions.length, read: spec.actions.length, write: 0, destructive: 0 },
    createdAt: 0,
    expiresAt: 0,
    ...overrides,
  };
}

async function runSequentially(statements: Awaited<ReturnType<typeof buildPersistStatements>>['statements']) {
  for (const stmt of statements) await stmt;
}

// Every table in the schema, serialized. A targeted assertion would only cover
// the columns we thought of; this covers the ones we didn't.
async function dumpEntireDatabase(): Promise<string> {
  const tables = Object.entries(schema).filter(
    ([, value]) => value && typeof value === 'object' && Symbol.for('drizzle:Name') in value,
  );
  const dump: Record<string, unknown> = {};
  for (const [name, table] of tables) {
    try {
      dump[name] = await db.select().from(table as never);
    } catch {
      // A view or non-selectable export — nothing to scan.
    }
  }
  return JSON.stringify(dump);
}

describe('persisting an import that carried a credential', () => {
  it('writes redaction receipts that record the drop without the value', async () => {
    const org = await makeOrg();
    const rec = curlRecord(`curl 'https://api.example.com/v1/charges?api_key=${SENTINEL}&limit=3'`);
    const rawText = 'curl-placeholder';

    const result = await buildPersistStatements(db, { orgId: org.id, record: rec, rawText });
    await runSequentially(result.statements);

    const facts = await db
      .select()
      .from(schema.evidenceFacts)
      .where(eq(schema.evidenceFacts.apiId, result.apiId));

    const redactionFacts = facts.filter((f) => f.kind === 'parser.redacted_example');
    expect(redactionFacts).toHaveLength(1);

    const [fact] = redactionFacts;
    expect(fact.redactionStatus).toBe('redacted');
    expect(fact.source).toBe('parser');
    const payload = fact.payload as Record<string, unknown>;
    expect(payload.reason).toBe('known_prefix');
    expect(payload.at).toMatch(/api_key$/);
    expect(payload.hint).toBe('••••OpQr');
    expect(JSON.stringify(payload)).not.toContain(SENTINEL);
  });

  it('leaves the sentinel nowhere in the entire database', async () => {
    const org = await makeOrg();
    const rec = curlRecord(
      `curl 'https://api.example.com/v1/intents?api_key=${SENTINEL}' -X POST ` +
        `-H 'Private-Token: ${GITLAB_TOKEN}' ` +
        `-d '{"amount":500,"client_secret":"${SENTINEL}"}'`,
    );

    const result = await buildPersistStatements(db, {
      orgId: org.id,
      record: rec,
      // The raw spec text is NOT written to Postgres — it goes to Blob, which
      // is deliberately out of scope here. Keep it clean so this asserts what
      // it claims to.
      rawText: 'curl-placeholder',
    });
    await runSequentially(result.statements);

    const everything = await dumpEntireDatabase();
    expect(everything).not.toContain(SENTINEL);
    expect(everything).not.toContain(GITLAB_TOKEN);
    // The endpoint itself still persisted — containment, not deletion.
    expect(everything).toContain('/v1/intents');
  });

  it('creates the api private, so a working authenticated request is not published by default', async () => {
    const org = await makeOrg();
    const rec = curlRecord(`curl 'https://api.example.com/v1/charges?api_key=${SENTINEL}'`);

    const result = await buildPersistStatements(db, { orgId: org.id, record: rec, rawText: 'x' });
    await runSequentially(result.statements);

    const [api] = await db.select().from(schema.apis).where(eq(schema.apis.id, result.apiId));
    expect(api.visibility).toBe('private');
  });
});

describe('an import that carried nothing sensitive', () => {
  it('stays public and writes no redaction receipts', async () => {
    const org = await makeOrg();
    const rec = curlRecord(`curl 'https://api.example.com/v1/pets?status=available&limit=20'`);

    const result = await buildPersistStatements(db, { orgId: org.id, record: rec, rawText: 'y' });
    await runSequentially(result.statements);

    const [api] = await db.select().from(schema.apis).where(eq(schema.apis.id, result.apiId));
    expect(api.visibility).toBe('public');

    const facts = await db
      .select()
      .from(schema.evidenceFacts)
      .where(eq(schema.evidenceFacts.apiId, result.apiId));
    expect(facts.filter((f) => f.kind === 'parser.redacted_example')).toHaveLength(0);
  });

  it('leaves a non-curl source public even when the spec had a redaction', async () => {
    // An OpenAPI spec with a leaked example is a PUBLISHED document — the
    // credential is already out, and making the page private helps nobody while
    // breaking the public-directory funnel. Strip the value, keep it public.
    const org = await makeOrg();
    const rec = curlRecord(`curl 'https://api.example.com/v1/charges?api_key=${SENTINEL}'`, {
      source: 'openapi',
    });

    const result = await buildPersistStatements(db, { orgId: org.id, record: rec, rawText: 'z' });
    await runSequentially(result.statements);

    const [api] = await db.select().from(schema.apis).where(eq(schema.apis.id, result.apiId));
    expect(api.visibility).toBe('public');
  });
});
