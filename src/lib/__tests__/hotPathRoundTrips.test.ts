// How many sequential database round trips an MCP advisor call costs.
//
// Every docentapi_* tool call from every agent goes through
// loadPersistentRecord and loadAdvisorInsights, against Neon over HTTP, where a
// round trip is a network hop rather than a socket write. Parallel queries in
// one stage cost roughly one hop; sequential stages cost one hop EACH. So the
// number that sets an agent's wait is stages, not queries, and this pins it.

import { beforeAll, describe, expect, it } from 'vitest';
import { loadAdvisorInsights } from '../advisor/insights';
import type { Action, ImportRecord } from '../ir';
import { buildPersistStatements } from '../persist';
import { loadPersistentRecord } from '../persistentApi';
import * as schema from '../db/schema';
import { createTracedTestDb, type RoundTripTrace } from '../db/__tests__/tracedDb';
import type { Db } from '../db';

let db: Db;
let trace: RoundTripTrace;

beforeAll(async () => {
  ({ db, trace } = await createTracedTestDb());
}, 30_000);

function action(name: string, path: string): Action {
  return {
    id: `id_${name}`,
    name,
    description: name,
    method: 'GET',
    path,
    paramsSchema: { type: 'object', properties: {} },
    auth: 'none',
    safety: 'read',
    examples: [],
  } as Action;
}

let seq = 0;
async function seedApi(): Promise<string> {
  seq += 1;
  const [org] = await db.insert(schema.orgs).values({ name: `HP Org ${seq}`, slug: `hp-org-${seq}` }).returning();
  const record: ImportRecord = {
    id: 'hp',
    name: `Hot Path ${seq}`,
    source: 'openapi',
    baseUrls: ['https://api.example.com'],
    auth: 'none',
    actions: [action('list_pets', '/pets'), action('get_pet', '/pets/{id}')],
    counts: { total: 2, read: 2, write: 0, destructive: 0 },
    createdAt: 0,
    expiresAt: 0,
  };
  const built = await buildPersistStatements(db, { orgId: org.id, record, rawText: `{"hp":${seq}}` });
  for (const statement of built.statements) await statement;
  return built.slug;
}

describe('sequential round trips on the advisor hot path', () => {
  it('loadPersistentRecord', async () => {
    const slug = await seedApi();
    trace.reset();

    const record = await loadPersistentRecord(slug, db);

    expect(record?.actions).toHaveLength(2);
    console.log(`loadPersistentRecord: ${trace.stages} stages / ${trace.queries} queries`);
    expect(trace.stages).toBeLessThanOrEqual(2);
  });

  it('loadAdvisorInsights', async () => {
    const slug = await seedApi();
    trace.reset();

    const insights = await loadAdvisorInsights(slug, db);

    expect(insights).toBeTruthy();
    console.log(`loadAdvisorInsights: ${trace.stages} stages / ${trace.queries} queries`);
    expect(trace.stages).toBeLessThanOrEqual(2);
  });
});
