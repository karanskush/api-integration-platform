import { verifySignatureAppRouter } from '@upstash/qstash/nextjs';
import { emailReady, sendWaitlistWelcomeEmail } from '@/lib/email';

export const maxDuration = 30;

const qstashReady = Boolean(process.env.QSTASH_CURRENT_SIGNING_KEY && process.env.QSTASH_NEXT_SIGNING_KEY);

async function handler(req: Request) {
  let body: { email?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const email = typeof body.email === 'string' ? body.email : '';
  if (!email) return Response.json({ error: 'Missing email' }, { status: 400 });

  if (!emailReady()) {
    return Response.json({ error: 'Email is not configured — connect Resend and redeploy' }, { status: 503 });
  }

  await sendWaitlistWelcomeEmail(email);
  return Response.json({ ok: true });
}

// Only wraps with real QStash signature verification when signing keys are
// configured — mirrors kv.ts/db.ts's xReady() gate rather than risking the
// wrapper doing anything unpredictable with unset keys.
export const POST = qstashReady
  ? verifySignatureAppRouter(handler)
  : async () => Response.json({ error: 'Job queue is not configured' }, { status: 503 });
