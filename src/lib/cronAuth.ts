// Cron endpoint authentication.
//
// A cron route is an unauthenticated POST that does expensive work on behalf of
// every tenant, so it is one of the more attractive endpoints in the app. Vercel
// sends `Authorization: Bearer $CRON_SECRET` on scheduled invocations; this
// checks it in constant time and refuses outright when no secret is configured.
//
// Fail CLOSED when CRON_SECRET is unset. The tempting alternative — "allow it if
// no secret is configured, for convenience" — would leave the endpoint wide open
// on exactly the deployments that forgot to set it, which is the population that
// most needs protecting.

import { secretsEqual } from './keys';

export type CronAuthResult = { ok: true } | { ok: false; status: number; error: string };

export function cronReady(): boolean {
  return Boolean(process.env.CRON_SECRET);
}

export function verifyCronRequest(req: Request): CronAuthResult {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return { ok: false, status: 503, error: 'Scheduled jobs are not configured — set CRON_SECRET and redeploy' };
  }

  const header = req.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!presented || !secretsEqual(presented, secret)) {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }
  return { ok: true };
}
