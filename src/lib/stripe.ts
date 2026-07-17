import Stripe from 'stripe';

// Same lazy xReady()/hard-fail-in-prod shape as kv.ts/db.ts. Both the secret
// key and webhook secret are required together — billing isn't meaningfully
// "ready" if subscription state can't be verified back in via webhooks.
export function billingReady(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET);
}

let instance: Stripe | null = null;

export function getStripe(): Stripe {
  if (!instance) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY is not set — configure Stripe to use billing.');
    }
    instance = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return instance;
}
