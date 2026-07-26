import { revalidatePath } from 'next/cache';
import { dbReady, getDb } from '@/lib/db';
import { verifyCronRequest } from '@/lib/cronAuth';
import { batchSize, findCandidates, reverifyOne, verifyIntervalHours } from '@/lib/reverify';

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
  const candidates = await findCandidates(db);

  const results = [];
  for (const candidate of candidates) {
    // Sequential on purpose: parallel probe runs would multiply outbound
    // request pressure on providers we do not control.
    const outcome = await reverifyOne(db, candidate);
    results.push(outcome);

    if (outcome.scored || outcome.specStatus === 'updated' || outcome.specStatus === 'reverted') {
      revalidatePath(`/${candidate.slug}`);
      revalidatePath(`/badge/${candidate.slug}`);
    }
  }

  return Response.json({
    ok: true,
    intervalHours: verifyIntervalHours(),
    batchSize: batchSize(),
    considered: candidates.length,
    verified: results.filter((r) => r.scored).length,
    specsUpdated: results.filter((r) => r.specStatus === 'updated').length,
    failed: results.filter((r) => !r.scored).length,
    durationMs: Date.now() - started,
    results,
  });
}

// Vercel's scheduler issues GET for cron paths; accept both so the same route
// works from the schedule and from a manual curl.
export const GET = POST;
