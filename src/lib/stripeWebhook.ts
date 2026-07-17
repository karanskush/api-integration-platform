import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import { planForPriceId } from './billing';
import type { Db } from './db';
import { orgs, stripeEvents } from './db/schema';

function customerId(customer: string | Stripe.Customer | Stripe.DeletedCustomer | null): string | null {
  if (!customer) return null;
  return typeof customer === 'string' ? customer : customer.id;
}

// Thin adapter around this: the route handler does the raw-body signature
// verification (constructEvent) and calls this with the parsed event — kept
// separate so tests exercise the actual state-transition logic against
// fixture events without touching the Stripe SDK at all.
export async function handleStripeEvent(event: Stripe.Event, db: Db): Promise<{ handled: boolean }> {
  // Stripe redelivers webhooks at-least-once; dedupe on the event id.
  const [inserted] = await db
    .insert(stripeEvents)
    .values({ id: event.id, type: event.type })
    .onConflictDoNothing({ target: stripeEvents.id })
    .returning({ id: stripeEvents.id });
  if (!inserted) return { handled: false };

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const orgId = session.metadata?.orgId;
      const plan = session.metadata?.plan;
      if (!orgId || !plan) break;
      await db
        .update(orgs)
        .set({
          plan,
          stripeCustomerId: customerId(session.customer) ?? undefined,
          stripeSubscriptionId:
            typeof session.subscription === 'string' ? session.subscription : (session.subscription?.id ?? undefined),
          stripeSubscriptionStatus: 'active',
          updatedAt: new Date(),
        })
        .where(eq(orgs.id, orgId));
      break;
    }
    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription;
      const cid = customerId(sub.customer);
      if (!cid) break;
      const priceId = sub.items.data[0]?.price?.id;
      const plan = priceId ? planForPriceId(priceId) : null;
      await db
        .update(orgs)
        .set({
          ...(plan ? { plan } : {}),
          stripeSubscriptionStatus: sub.status,
          stripePriceId: priceId,
          updatedAt: new Date(),
        })
        .where(eq(orgs.stripeCustomerId, cid));
      break;
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const cid = customerId(sub.customer);
      if (!cid) break;
      await db
        .update(orgs)
        .set({ plan: 'free', stripeSubscriptionStatus: 'canceled', updatedAt: new Date() })
        .where(eq(orgs.stripeCustomerId, cid));
      break;
    }
    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      const cid = customerId(invoice.customer);
      if (!cid) break;
      await db
        .update(orgs)
        .set({ stripeSubscriptionStatus: 'past_due', updatedAt: new Date() })
        .where(eq(orgs.stripeCustomerId, cid));
      break;
    }
    default:
      break;
  }

  return { handled: true };
}
