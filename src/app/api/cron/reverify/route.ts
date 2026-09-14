import { dbReady, getDb } from '@/lib/db';
import { verifyCronRequest } from '@/lib/cronAuth';
import { purgeApiSurfaces } from '@/lib/purge';
import { batchSize, findCandidates, reverifyOne, verifyIntervalHours } from '@/lib/reverify';
import { reapAbandonedScoreRuns } from '@/lib/scoreRunReaper';

// Probes make real upstream requests against several APIs per run, so this
// needs the long end of the function budget rather than the default.
export const maxDuration = 300;

// Scheduled re-verification. Wired to a Vercel cron in vercel.json; also
// callable manually with the same CRON_SECRET, which is how you test it in
// production without waiting for the schedule.
//
// Failure of one API must never abort the batch — a single provider being down
// would otherwise stall re-verification for everyone behind it in the queue.
export async function POST(req: Request) {
  const authorized = verifyCronRequest(req);
  if (!authorized.ok) {
    return Response.json({ error: authorized.error }, { status: authorized.status });
  }
  if (!dbReady()) {
    return Response.json({ error: 'Persistence is not configured — connect Postgres and redeploy' }, { status: 503 });
  }

  const db = getDb();
  const started = Date.now();

  // Before anything else: close out runs whose function died mid-flight. This
  // is the only job that runs on a schedule across every API, so it is the
  // only place that can see them.
  const abandoned = await reapAbandonedScoreRuns(db);

  const candidates = await findCandidates(db);

  const results = [];
  for (const candidate of candidates) {
    // Sequential on purpose: parallel probe runs would multiply outbound
    // request pressure on providers we do not control.
    const outcome = await reverifyOne(db, candidate);
    results.push(outcome);

    if (outcome.scored || outcome.specStatus === 'updated' || outcome.specStatus === 'reverted') {
      purgeApiSurfaces(candidate.slug);
    }
  }

  return Response.json({
    ok: true,
    intervalHours: verifyIntervalHours(),
    batchSize: batchSize(),
    considered: candidates.length,
    abandonedRunsClosed: abandoned,
    verified: results.filter((r) => r.scored).length,
    specsUpdated: results.filter((r) => r.specStatus === 'updated').length,
    behaviourChanges: results.reduce((sum, r) => sum + (r.canary?.changes ?? 0), 0),
    operationsDrifted: results.reduce((sum, r) => sum + (r.canary?.drifted ?? 0), 0),
    operationsInconclusive: results.reduce((sum, r) => sum + (r.canary?.inconclusive ?? 0), 0),
    failed: results.filter((r) => !r.scored).length,
    durationMs: Date.now() - started,
    results,
  });
}

// Vercel's scheduler issues GET for cron paths; accept both so the same route
// works from the schedule and from a manual curl.
export const GET = POST;
