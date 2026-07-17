// In-process WASM Postgres for tests — no Docker/daemon dependency, fits the
// project's zero-config vitest convention. Runs the real drizzle-kit-
// generated migrations, so tests exercise the actual schema/constraints.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Db } from '../../db';
import * as schema from '../schema';

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../drizzle');

export async function createTestDb(): Promise<Db> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  return db;
}

export type TestDb = Db;
