// Whether a failed deep-analysis stage should be retried before the chain moves
// on without it.
//
// GAP_ANALYSIS_2026-08-04.md §0.5. analyze-crawl and analyze-enrich catch their
// own failures, mark the run failed, chain forward and return 200 — so QStash,
// which retries on a non-2xx, never got the chance. A transient crawl or
// enrichment failure was therefore PERMANENT for that spec version.
//
// The chaining-forward itself is deliberate and stays: a doc crawl that fails
// entirely is not fatal, because enrichment still has the spec to work from, and
// dead-ending the pipeline on it would be worse than proceeding with less. The
// defect is that a network blip and a genuinely impossible crawl were treated
// identically, with zero attempts in between.
//
// So: retry a bounded number of times, then fall through to exactly today's
// behaviour. A transient failure gets a real second chance; a permanent one
// costs two extra attempts and then proceeds as it always did. The pipeline can
// never stall, which is the property the original design was protecting.
//
// Retry on ANY failure rather than on a classified subset. Deciding which error
// names are transient is a guess about somebody else's infrastructure, it drifts
// as dependencies change, and being wrong in the cautious direction costs two
// requests while being wrong the other way is what this fixes.

import { and, eq } from 'drizzle-orm';
import type { Db } from './db';
import { analysisRuns } from './db/schema';

/** Initial attempt plus two retries. */
export const MAX_STAGE_ATTEMPTS = 3;

export type AnalysisStage = 'parse' | 'crawl' | 'enrich' | 'finalize';

/**
 * How many times this stage has been attempted for this spec version.
 *
 * Counts `analysis_runs` rows, which each stage inserts before doing any work —
 * so the current attempt is included, and the first failure sees 1.
 */
export async function attemptsSoFar(
  db: Db,
  apiId: string,
  specVersionId: string,
  stage: AnalysisStage,
): Promise<number> {
  const rows = await db
    .select({ id: analysisRuns.id })
    .from(analysisRuns)
    .where(
      and(
        eq(analysisRuns.apiId, apiId),
        eq(analysisRuns.specVersionId, specVersionId),
        eq(analysisRuns.stage, stage),
      ),
    );
  return rows.length;
}

/**
 * True while the stage still has attempts left, meaning the route should answer
 * non-2xx so QStash retries instead of chaining forward.
 */
export function shouldRetryStage(attempts: number): boolean {
  return attempts < MAX_STAGE_ATTEMPTS;
}
