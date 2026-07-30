// "Do we already have this spec?" — the check that makes a repeat import free.
//
// /api/apis/analyze runs an LLM enrichment pass and a bounded documentation
// crawl. Re-running that for bytes we have already analysed spends real money
// and forks a duplicate page (persist.ts always mints a fresh apis row, which
// is right for a first import and wrong for every later one). So identity is
// the spec itself:
//
//   same content hash — definitionally the same spec, nothing new to learn.
//   same source URL   — the same spec, possibly at a newer revision.
//
// Scoped to one org: two orgs importing the same public spec each keep their
// own page, which is the existing contract everywhere else.
//
// Known gap: a pasted spec carries no source URL, so a newer paste of a
// previously pasted API cannot be recognised and does create a second page.
// Importing by URL is what makes revision tracking possible.

import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from './db';
import { apis, specVersions } from './db/schema';

export function specContentHash(rawText: string): string {
  return createHash('sha256').update(rawText).digest('hex');
}

export type ExistingApi = {
  apiId: string;
  slug: string;
  analysisStatus: string;
  // True when the incoming bytes ARE this API's current version — i.e. there
  // is genuinely nothing to re-analyse.
  isCurrentSpec: boolean;
};

export async function findOrgApiForSpec(
  db: Db,
  orgId: string,
  spec: { contentHash: string; sourceUrl?: string | null },
): Promise<ExistingApi | null> {
  const columns = {
    apiId: apis.id,
    slug: apis.slug,
    analysisStatus: apis.analysisStatus,
    currentSpecVersionId: apis.currentSpecVersionId,
  };

  const matchOn = async (predicate: ReturnType<typeof eq>) =>
    db
      .select(columns)
      .from(apis)
      .innerJoin(specVersions, eq(specVersions.apiId, apis.id))
      .where(and(eq(apis.orgId, orgId), predicate))
      // Newest version first: a URL re-imported many times should resolve to
      // the API tracking it, not to whichever row the planner happens to hit.
      .orderBy(desc(specVersions.createdAt))
      .limit(1);

  let [found] = await matchOn(eq(specVersions.contentHash, spec.contentHash));
  if (!found && spec.sourceUrl) {
    [found] = await matchOn(eq(specVersions.sourceUrl, spec.sourceUrl));
  }
  if (!found) return null;

  // Compare against the CURRENT version's hash rather than the row we matched
  // on — matching an older version by URL still means the spec has moved on.
  let isCurrentSpec = false;
  if (found.currentSpecVersionId) {
    const [current] = await db
      .select({ contentHash: specVersions.contentHash })
      .from(specVersions)
      .where(eq(specVersions.id, found.currentSpecVersionId))
      .limit(1);
    isCurrentSpec = current?.contentHash === spec.contentHash;
  }

  return { apiId: found.apiId, slug: found.slug, analysisStatus: found.analysisStatus, isCurrentSpec };
}
