// Closing out score runs whose function died before they could finish.
//
// BUILD_PLAN latent defect 5. Both writers — /api/apis/[slug]/verify and
// reverifyOne — insert a `running` row and then update it to a terminal state
// in a try/catch. That covers a run that throws. It does not cover the process
// disappearing: a function timeout, an OOM, a deploy mid-run. Those rows keep
// claiming to be in progress forever, and nothing reaped them.
//
// The claim is what makes this worth fixing rather than tolerating. score_runs
// is the audit trail for "did we actually probe this API, and what happened" —
// a row permanently asserting `running` is not a harmless orphan, it is the
// table's own record saying a run is still going when it has not existed for
// weeks. The same reasoning as §12.11's terminal run states: a run that ended
// badly has an outcome, and "still going" is not it.
//
// Vercel's ceiling for these paths is maxDuration = 300, so a row older than
// the cutoff below cannot still be executing. The bound is deliberately far
// past that rather than snug against it: reaping a run that is genuinely still
// alive would have it overwrite its own terminal state a moment later, and
// being slow to close an abandoned row costs nothing.

import { and, eq, lt } from 'drizzle-orm';
import type { Db } from './db';
import { scoreRuns } from './db/schema';

/** Comfortably beyond the 300s ceiling of the longest-running writer. */
export const ABANDONED_AFTER_MS = 30 * 60 * 1000;

/**
 * Marks `running` rows older than the cutoff as failed.
 *
 * Returns how many were closed. Deliberately not scoped to one API: a run is
 * abandoned because its process died, which says nothing about which API it
 * belonged to, and the caller is the scheduled job that already runs across
 * the whole table.
 */
export async function reapAbandonedScoreRuns(db: Db, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - ABANDONED_AFTER_MS);
  const reaped = await db
    .update(scoreRuns)
    .set({
      status: 'failed',
      // A closed vocabulary, like every other error this codebase persists —
      // never a message, which is how a URL or an identifier gets in.
      error: 'abandoned',
      completedAt: now,
    })
    .where(and(eq(scoreRuns.status, 'running'), lt(scoreRuns.startedAt, cutoff)))
    .returning({ id: scoreRuns.id });

  return reaped.length;
}
