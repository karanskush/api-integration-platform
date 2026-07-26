import { auth, currentUser } from '@clerk/nextjs/server';
import { eq } from 'drizzle-orm';
import { isSelfServePlan, priceIdForPlan } from '@/lib/billing';
import { dbReady, getDb } from '@/lib/db';
import { orgs } from '@/lib/db/schema';
import { getOrCreateOrgForUser } from '@/lib/org';
import { getLimiter, tooMany } from '@/lib/ratelimit';
import { billingReady, getStripe } from '@/lib/stripe';

export const maxDuration = 30;

// Each call can create a Stripe customer and a Checkout session, so an
// unthrottled loop here is billable third-party traffic, not just CPU.
const CHECKOUT_LIMIT = { limit: 10, windowSec: 600 };

export async function POST(req: Request) {
  if (!dbReady()) {
    return Response.json({ error: 'Persistence is not configured — connect Postgres and redeploy' }, { status: 503 });
  }
  if (!billingReady()) {
    return Response.json({ error: 'Billing is not configured — connect Stripe and redeploy' }, { status: 503 });
  }

  const { userId } = await auth();
  if (!userId) return Response.json({ error: 'Sign in required' }, { status: 401 });

  const rl = await getLimiter('billing-checkout', CHECKOUT_LIMIT).limit(userId);
  if (!rl.success) return tooMany(rl.reset);

  let body: { plan?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const plan = typeof body.plan === 'string' ? body.plan : '';
  if (!isSelfServePlan(plan)) {
    return Response.json(
      { error: 'This plan requires contacting sales — self-serve checkout only covers Launch and Pro' },
      { status: 400 },
    );
  }

  const user = await currentUser();
  const email = user?.primaryEmailAddress?.emailAddress ?? user?.emailAddresses[0]?.emailAddress;
  if (!email) return Response.json({ error: 'Your account has no email address on file' }, { status: 400 });

  const db = getDb();
  const { org } = await getOrCreateOrgForUser(db, userId, email);

  const stripe = getStripe();
  let customerId = org.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({ email, metadata: { orgId: org.id } });
    customerId = customer.id;
    await db.update(orgs).set({ stripeCustomerId: customerId }).where(eq(orgs.id, org.id));
  }

  const origin = process.env.PUBLIC_APP_ORIGIN?.replace(/\/$/, '') || new URL(req.url).origin;
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceIdForPlan(plan), quantity: 1 }],
    success_url: `${origin}/dashboard?checkout=success`,
    cancel_url: `${origin}/pricing?checkout=cancelled`,
    metadata: { orgId: org.id, plan },
  });

  return Response.json({ url: session.url });
}
