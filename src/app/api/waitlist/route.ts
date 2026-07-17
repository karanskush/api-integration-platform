import { corsPreflight, withCorsJson } from '@/lib/cors';
import { dbReady, getDb } from '@/lib/db';
import { waitlist } from '@/lib/db/schema';
import { clientIp } from '@/lib/ip';
import { kv, storageReady } from '@/lib/kv';
import { publishJob, queueReady } from '@/lib/queue';
import { getLimiter, tooMany } from '@/lib/ratelimit';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function OPTIONS(req: Request) {
  return corsPreflight(req);
}

export async function POST(req: Request) {
  const rl = await getLimiter('waitlist', { limit: 5, windowSec: 60 }).limit(clientIp(req));
  if (!rl.success) return tooMany(rl.reset);

  let body: { email?: unknown; source?: unknown };
  try {
    body = await req.json();
  } catch {
    return withCorsJson(req, { error: 'Invalid JSON body' }, { status: 400 });
  }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return withCorsJson(req, { error: 'Invalid email address' }, { status: 400 });
  }
  const source = typeof body.source === 'string' ? body.source.slice(0, 40) : 'landing';

  // Postgres is authoritative once available — no dual-write with Redis.
  // Same public contract and {ok:true}-on-duplicate behavior either way, so
  // the marketing site's existing form handler never needs to change.
  if (dbReady()) {
    const db = getDb();
    const [inserted] = await db
      .insert(waitlist)
      .values({ email, source })
      .onConflictDoNothing({ target: waitlist.email })
      .returning({ id: waitlist.id });
    if (inserted && queueReady()) {
      await publishJob('/api/jobs/send-waitlist-email', { email });
    }
    return withCorsJson(req, { ok: true });
  }

  if (!storageReady()) {
    return withCorsJson(req, { error: 'Storage not configured — connect Upstash Redis and redeploy' }, { status: 503 });
  }
  await kv().addWaitlist({ email, ts: Date.now(), source });
  return withCorsJson(req, { ok: true });
}
