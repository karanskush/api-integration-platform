import { dbReady, getDb } from '@/lib/db';
import { verifyCronRequest } from '@/lib/cronAuth';
import { purgeApiSurfaces } from '@/lib/purge';
import { findPollCandidates, pollBatchSize, pollOne } from '@/lib/specPoll';

// Each candidate is a real outbound request to a provider, so this needs the
// long end of the function budget like the reverify cron does.
export const maxDuration = 300;

// Hourly spec poll. Wired to a Vercel cron in vercel.json; also callable
// manually with the same CRON_SECRET, which is how you exercise it in
// production without waiting for the schedule.
//
// Unlike re-verification, this runs for EVERY plan — a page that silently
// describes a contract the provider has already changed is the failure the
// product exists to prevent, and detecting that must not be a paid feature.
// Cadence is what the plan buys (specPoll.pollIntervalHours).
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
  const candidates = await findPollCandidates(db);

  const results = [];
  for (const candidate of candidates) {
    // Sequential on purpose: parallel polls would multiply outbound request
    // pressure on providers we do not control (same rule as reverify).
    const outcome = await pollOne(db, candidate);
    results.push(outcome);

    // A 304 or an unchanged hash changes nothing a visitor can see. A new or
    // reverted version changes the page, the changelog, the feed, and the
    // badge's freshness line all at once.
    if (outcome.status === 'updated' || outcome.status === 'reverted') {
      purgeApiSurfaces(candidate.slug);
    }
  }

  return Response.json({
    ok: true,
    batchSize: pollBatchSize(),
    considered: candidates.length,
    notModified: results.filter((r) => r.status === 'not_modified').length,
    unchanged: results.filter((r) => r.status === 'unchanged').length,
    updated: results.filter((r) => r.status === 'updated').length,
    reverted: results.filter((r) => r.status === 'reverted').length,
    failed: results.filter((r) => r.status === 'failed').length,
    durationMs: Date.now() - started,
    results,
  });
}

// Vercel's scheduler issues GET for cron paths; accept both so the same route
// works from the schedule and from a manual curl.
export const GET = POST;
