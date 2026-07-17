import { dbReady, getDb } from './db';
import { getOrCreateSystemOrg } from './db/seedSystemOrg';
import { runImport } from './importer';
import { persistApi } from './persist';

export type SeedUnclaimedInput = { sourceUrl?: string; sourceText?: string; name?: string };

// Local-only seeding path (scripts/seed-unclaimed.mjs) — unlike the rest of
// this codebase's graceful "no DATABASE_URL" degradation, seeding without a
// real database to write to is meaningless, so fail fast and clearly rather
// than let getDb() throw partway through, after the (possibly slow) import.
export async function seedUnclaimedApi(input: SeedUnclaimedInput): Promise<{ slug: string }> {
  if (!dbReady()) {
    throw new Error(
      'DATABASE_URL is not set — set it to a Neon Postgres connection string in .env.local to seed unclaimed pages.',
    );
  }

  const { record, rawText } = await runImport({ url: input.sourceUrl, text: input.sourceText });
  if (input.name) record.name = input.name;

  const db = getDb();
  const systemOrg = await getOrCreateSystemOrg(db);
  const { slug } = await persistApi(db, { orgId: systemOrg.id, record, rawText, claimStatus: 'unclaimed' });
  return { slug };
}
