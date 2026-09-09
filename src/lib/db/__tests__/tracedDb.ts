// A test database that counts how many SEQUENTIAL round trips a code path
// costs — the number that actually sets latency against Neon over HTTP, where
// every stage is a network hop and parallel queries within a stage are nearly
// free by comparison.
//
// Ordinal, not timed: a query opens a new stage iff every query issued before
// it had already completed when it was issued. Queries fired inside one
// Promise.all are issued back to back before any completes, so they share a
// stage; a query that waits on an `await` of the previous result starts a new
// one. No clock is involved, so the count cannot jitter.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Db } from '../../db';
import * as schema from '../schema';

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../drizzle');

export type RoundTripTrace = {
  /** Sequential stages so far. */
  stages: number;
  /** Total queries so far. */
  queries: number;
  reset(): void;
};

export async function createTracedTestDb(): Promise<{ db: Db; trace: RoundTripTrace }> {
  const client = new PGlite();
  let issued = 0;
  let completed = 0;
  const trace: RoundTripTrace = {
    stages: 0,
    queries: 0,
    reset() {
      issued = 0;
      completed = 0;
      this.stages = 0;
      this.queries = 0;
    },
  };

  // drizzle's pglite driver funnels every statement through client.query.
  const original = client.query.bind(client);
  client.query = (async (...args: Parameters<typeof original>) => {
    if (completed === issued) trace.stages += 1;
    issued += 1;
    trace.queries += 1;
    try {
      return await original(...args);
    } finally {
      completed += 1;
    }
  }) as typeof client.query;

  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  return { db, trace };
}
