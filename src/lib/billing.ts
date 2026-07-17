import type { Plan } from './plans';

type PaidPlan = Exclude<Plan, 'free'>;

// Only Launch/Pro get live self-serve checkout in Phase 1 — Team/Business's
// gated features (vaulted creds, custom domain, SLA/audit) don't exist yet,
// so selling them self-serve would be selling something that doesn't work.
// They route to a contact form instead (dashboard UI, not built here).
export function isSelfServePlan(plan: string): plan is 'launch' | 'pro' {
  return plan === 'launch' || plan === 'pro';
}

// Never hardcoded: test vs live Stripe price ids differ, and these are
// supplied once real Stripe credentials are provisioned.
function priceEnv(): Record<PaidPlan, string | undefined> {
  return {
    launch: process.env.STRIPE_PRICE_LAUNCH,
    pro: process.env.STRIPE_PRICE_PRO,
    team: process.env.STRIPE_PRICE_TEAM,
    business: process.env.STRIPE_PRICE_BUSINESS,
  };
}

export function priceIdForPlan(plan: PaidPlan): string {
  const id = priceEnv()[plan];
  if (!id) {
    throw new Error(`No Stripe price id configured for plan "${plan}" — set STRIPE_PRICE_${plan.toUpperCase()}`);
  }
  return id;
}

// Maps a Stripe price id back to our plan name — used by the webhook
// handler to figure out which plan a subscription.updated event refers to,
// including Team/Business subscriptions set up manually via the Stripe
// dashboard (not just the two self-serve plans above).
export function planForPriceId(priceId: string): Plan | null {
  const entries = Object.entries(priceEnv()) as Array<[PaidPlan, string | undefined]>;
  for (const [plan, id] of entries) {
    if (id && id === priceId) return plan;
  }
  return null;
}
