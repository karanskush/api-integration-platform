import { dbReady, getDb } from '@/lib/db';
import { billingReady, getStripe } from '@/lib/stripe';
import { handleStripeEvent } from '@/lib/stripeWebhook';

export const maxDuration = 30;

export async function POST(req: Request) {
  if (!dbReady() || !billingReady()) {
    return Response.json({ error: 'Billing is not configured' }, { status: 503 });
  }

  const signature = req.headers.get('stripe-signature');
  if (!signature) return Response.json({ error: 'Missing stripe-signature header' }, { status: 400 });

  // Must read the raw body — signature verification breaks on anything that
  // touches the bytes first (JSON.parse, etc.).
  const rawBody = await req.text();

  const stripe = getStripe();
  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch {
    return Response.json({ error: 'Invalid signature' }, { status: 400 });
  }

  await handleStripeEvent(event, getDb());
  return Response.json({ received: true });
}
