import { auth, currentUser } from '@clerk/nextjs/server';
import { dbReady, getDb } from '@/lib/db';
import { getOrCreateOrgForUser } from '@/lib/org';
import { getLimiter, tooMany } from '@/lib/ratelimit';
import { billingReady, getStripe } from '@/lib/stripe';
import { appOrigin } from '@/lib/origin';

export const maxDuration = 30;

const PORTAL_LIMIT = { limit: 10, windowSec: 600 };

export async function POST(req: Request) {
  if (!dbReady()) {
    return Response.json({ error: 'Persistence is not configured — connect Postgres and redeploy' }, { status: 503 });
  }
  if (!billingReady()) {
    return Response.json({ error: 'Billing is not configured — connect Stripe and redeploy' }, { status: 503 });
  }

  const { userId } = await auth();
  if (!userId) return Response.json({ error: 'Sign in required' }, { status: 401 });

  const rl = await getLimiter('billing-portal', PORTAL_LIMIT).limit(userId);
  if (!rl.success) return tooMany(rl.reset);

  const user = await currentUser();
  const email = user?.primaryEmailAddress?.emailAddress ?? user?.emailAddresses[0]?.emailAddress;
  if (!email) return Response.json({ error: 'Your account has no email address on file' }, { status: 400 });

  const db = getDb();
  const { org } = await getOrCreateOrgForUser(db, userId, email);
  if (!org.stripeCustomerId) {
    return Response.json({ error: 'No billing account yet — subscribe to a plan first' }, { status: 400 });
  }

  const stripe = getStripe();
  const origin = appOrigin(req);
  const session = await stripe.billingPortal.sessions.create({
    customer: org.stripeCustomerId,
    return_url: `${origin}/dashboard`,
  });

  return Response.json({ url: session.url });
}
