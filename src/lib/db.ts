import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import type { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './db/schema';

// Dialect-agnostic on purpose: the pglite-backed test harness (testDb.ts)
// constructs a different concrete driver than the real Neon one, and
// functions like org.ts's getOrCreateOrgForUser() need a type both satisfy —
// this only covers the common query-builder surface (select/insert/update).
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

// The concrete type getDb() actually returns. Needed wherever code calls a
// Neon-HTTP-specific method like `.batch()` (see persist.ts) — those aren't
// part of the dialect-agnostic Db type above, and pglite's test driver
// doesn't implement them (it has no need to: it supports real transactions,
// which neon-http does not).
export type NeonDb = NeonHttpDatabase<typeof schema>;

// Unlike kv.ts's Redis fallback, there is no in-memory stand-in for Postgres
// here — routes must check dbReady() first and return a clear "not
// configured" response, the same shape storage/billing 503s already use.
// (A pglite-backed fallback was considered and rejected: pglite is a
// devDependency used only by the vitest harness — importing it from runtime
// code would either crash a real Vercel build, where devDependencies aren't
// installed, or force it into every production bundle.)
export function dbReady(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

let instance: NeonDb | null = null;

export function getDb(): NeonDb {
  if (!instance) {
    if (!dbReady()) {
      throw new Error(
        'DATABASE_URL is not set — set it to a Neon Postgres connection string (provision via the Vercel Marketplace) to use persistence features locally, or run `npm run db:migrate` against a dev branch.',
      );
    }
    instance = drizzle(neon(process.env.DATABASE_URL!), { schema });
  }
  return instance;
}
