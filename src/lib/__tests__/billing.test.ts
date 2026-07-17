import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type Stripe from 'stripe';
import * as schema from '../db/schema';
import { createTestDb, type TestDb } from '../db/__tests__/testDb';
import { handleStripeEvent } from '../stripeWebhook';
import { can, limitsFor } from '../plans';
import checkoutCompletedFixture from './fixtures/stripe/checkout-session-completed.json';
import subscriptionUpdatedFixture from './fixtures/stripe/subscription-updated.json';
import subscriptionDeletedFixture from './fixtures/stripe/subscription-deleted.json';
import invoicePaymentFailedFixture from './fixtures/stripe/invoice-payment-failed.json';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
}, 30_000);

async function makeOrg(suffix: string) {
  const [org] = await db.insert(schema.orgs).values({ name: `Billing Org ${suffix}`, slug: `billing-org-${suffix}` }).returning();
  return org;
}

function clone<T>(fixture: T): T {
  return structuredClone(fixture);
}

describe('handleStripeEvent: checkout.session.completed', () => {
  it('flips the org to the checked-out plan and stores customer/subscription ids', async () => {
    const org = await makeOrg('checkout');
    const event = clone(checkoutCompletedFixture);
    event.id = `evt_${org.id}`;
    event.data.object.customer = `cus_${org.id}`;
    event.data.object.subscription = `sub_${org.id}`;
    event.data.object.metadata.orgId = org.id;

    await handleStripeEvent(event as unknown as Stripe.Event, db);

    const [updated] = await db.select().from(schema.orgs).where(eq(schema.orgs.id, org.id));
    expect(updated.plan).toBe('launch');
    expect(updated.stripeCustomerId).toBe(`cus_${org.id}`);
    expect(updated.stripeSubscriptionId).toBe(`sub_${org.id}`);
    expect(updated.stripeSubscriptionStatus).toBe('active');
  });

  it('is idempotent: replaying the same event id is a no-op the second time', async () => {
    const org = await makeOrg('checkout-dup');
    const event = clone(checkoutCompletedFixture);
    event.id = `evt_${org.id}`;
    event.data.object.customer = `cus_${org.id}`;
    event.data.object.subscription = `sub_${org.id}`;
    event.data.object.metadata.orgId = org.id;
    event.data.object.metadata.plan = 'pro';

    const first = await handleStripeEvent(event as unknown as Stripe.Event, db);
    expect(first.handled).toBe(true);

    // Simulate a redelivery with a different plan in the payload — if dedup
    // works, this must NOT apply, proving the second delivery was skipped.
    const replay = clone(event);
    replay.data.object.metadata.plan = 'business';
    const second = await handleStripeEvent(replay as unknown as Stripe.Event, db);
    expect(second.handled).toBe(false);

    const [row] = await db.select().from(schema.orgs).where(eq(schema.orgs.id, org.id));
    expect(row.plan).toBe('pro');
  });
});

describe('handleStripeEvent: customer.subscription.updated', () => {
  const ORIGINAL_PRICE_ENV = process.env.STRIPE_PRICE_PRO;

  beforeEach(() => {
    process.env.STRIPE_PRICE_PRO = 'price_pro_placeholder';
  });
  afterEach(() => {
    process.env.STRIPE_PRICE_PRO = ORIGINAL_PRICE_ENV;
  });

  it('updates plan and subscription status by matching customer id', async () => {
    const org = await makeOrg('sub-updated');
    await db.update(schema.orgs).set({ stripeCustomerId: 'cus_sub_updated_test' }).where(eq(schema.orgs.id, org.id));

    const event = clone(subscriptionUpdatedFixture);
    event.id = `evt_${org.id}`;
    event.data.object.customer = 'cus_sub_updated_test';

    await handleStripeEvent(event as unknown as Stripe.Event, db);

    const [updated] = await db.select().from(schema.orgs).where(eq(schema.orgs.id, org.id));
    expect(updated.plan).toBe('pro');
    expect(updated.stripeSubscriptionStatus).toBe('active');
    expect(updated.stripePriceId).toBe('price_pro_placeholder');
  });
});

describe('handleStripeEvent: customer.subscription.deleted', () => {
  it('downgrades the org back to free', async () => {
    const org = await makeOrg('sub-deleted');
    await db
      .update(schema.orgs)
      .set({ plan: 'pro', stripeCustomerId: 'cus_sub_deleted_test' })
      .where(eq(schema.orgs.id, org.id));

    const event = clone(subscriptionDeletedFixture);
    event.id = `evt_${org.id}`;
    event.data.object.customer = 'cus_sub_deleted_test';

    await handleStripeEvent(event as unknown as Stripe.Event, db);

    const [updated] = await db.select().from(schema.orgs).where(eq(schema.orgs.id, org.id));
    expect(updated.plan).toBe('free');
    expect(updated.stripeSubscriptionStatus).toBe('canceled');
  });
});

describe('handleStripeEvent: invoice.payment_failed', () => {
  it('marks the subscription past_due without changing plan', async () => {
    const org = await makeOrg('invoice-failed');
    await db
      .update(schema.orgs)
      .set({ plan: 'pro', stripeCustomerId: 'cus_invoice_failed_test' })
      .where(eq(schema.orgs.id, org.id));

    const event = clone(invoicePaymentFailedFixture);
    event.id = `evt_${org.id}`;
    event.data.object.customer = 'cus_invoice_failed_test';

    await handleStripeEvent(event as unknown as Stripe.Event, db);

    const [updated] = await db.select().from(schema.orgs).where(eq(schema.orgs.id, org.id));
    expect(updated.plan).toBe('pro');
    expect(updated.stripeSubscriptionStatus).toBe('past_due');
  });
});

describe('plan cap sanity check against fixtures', () => {
  it('a fresh free-plan org is under its own cap', () => {
    expect(limitsFor('free').maxPersistentApis).toBeGreaterThanOrEqual(1);
    expect(can('free', 'privateApis')).toBe(false);
  });
});
