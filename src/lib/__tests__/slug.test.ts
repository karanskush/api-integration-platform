import { describe, expect, it } from 'vitest';
import { allocateApiSlug } from '../slug';
import { slugify } from '../slugify';

describe('slugify', () => {
  it('kebab-cases and lowercases', () => {
    expect(slugify('Stripe API')).toBe('stripe-api');
    expect(slugify('  My_Cool.API!! ')).toBe('my-cool-api');
  });

  it('falls back to a placeholder for empty input', () => {
    expect(slugify('***')).toBe('x');
  });
});

describe('allocateApiSlug', () => {
  it('returns the plain slug when free', async () => {
    const slug = await allocateApiSlug('Stripe', async () => false);
    expect(slug).toBe('stripe');
  });

  it('suffixes on collision with an existing api', async () => {
    const taken = new Set(['stripe']);
    const slug = await allocateApiSlug('Stripe', async (c) => taken.has(c));
    expect(slug).toBe('stripe-2');
  });

  it('never allocates a reserved static-route slug', async () => {
    const slug = await allocateApiSlug('pricing', async () => false);
    expect(slug).toBe('pricing-2');
  });

  it('walks past multiple collisions', async () => {
    const taken = new Set(['dashboard', 'dashboard-2', 'dashboard-3']);
    const slug = await allocateApiSlug('Dashboard', async (c) => taken.has(c));
    expect(slug).toBe('dashboard-4');
  });
});
