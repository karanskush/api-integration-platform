import { verifyCronRequest } from '@/lib/cronAuth';
import { dbReady, getDb } from '@/lib/db';
import { reportDailyUsage } from '@/lib/usageReporting';

export const maxDuration = 120;

// Reports yesterday's metered MCP credit usage to Stripe. Scheduled shortly
// after UTC midnight (vercel.json) so the day it reports is closed.
//
// Safe to re-run: every meter event carries a deterministic identifier per
// (org, day), which Stripe dedupes on, so a retry after a partial failure
// completes the batch rather than double-billing anyone.
export async function POST(req: Request) {
  const authorized = verifyCronRequest(req);
  if (!authorized.ok) {
    return Response.json({ error: authorized.error }, { status: authorized.status });
  }
  if (!dbReady()) {
    return Response.json({ error: 'Persistence is not configured — connect Postgres and redeploy' }, { status: 503 });
  }

  const started = Date.now();
  const result = await reportDailyUsage(getDb());

  return Response.json({
    ok: true,
    day: result.day,
    ...(result.skipped ? { skipped: result.skipped } : {}),
    orgsReported: result.orgs.filter((o) => o.reported).length,
    orgsFailed: result.orgs.filter((o) => !o.reported).length,
    totalCredits: result.totalCredits,
    durationMs: Date.now() - started,
  });
}

export const GET = POST;
