'use client';

import { useState } from 'react';

// Tier copy/order mirrors legacy-site/index.html's #pricing section exactly
// — same tiers, prices, and feature bullets, wired to real checkout instead
// of the marketing site's static mockup.
type Tier = {
  key: string;
  name: string;
  price: number;
  blurb: string;
  features: string[];
  selfServe: boolean;
  featured?: boolean;
};

const TIERS: Tier[] = [
  {
    key: 'free',
    name: 'Free',
    price: 0,
    blurb: 'For every public API on the internet.',
    features: ['Unlimited public pages', 'BYOK playground', 'Hosted MCP, fair-use calls', 'Agent-Ready Score + badge'],
    selfServe: false,
  },
  {
    key: 'launch',
    name: 'Launch',
    price: 29,
    blurb: 'For the indie founder shipping an API.',
    features: ['Up to 3 APIs', 'Higher MCP credits', 'Code snippets, all languages', 'Email support'],
    selfServe: true,
  },
  {
    key: 'pro',
    name: 'Pro',
    price: 79,
    blurb: "For the API that's becoming a product.",
    features: ['Up to 10 APIs', 'Usage analytics: humans + agents', 'Priority import + re-verify', 'Remove Spotcheck branding'],
    selfServe: true,
    featured: true,
  },
  {
    key: 'team',
    name: 'Team',
    price: 199,
    blurb: 'For teams with private APIs to serve.',
    features: ['Private pages & MCP', 'Vaulted credentials', 'Custom domain', '5 seats included'],
    selfServe: false,
  },
  {
    key: 'business',
    name: 'Business',
    price: 499,
    blurb: 'For APIs that agents run in production.',
    features: ['Scheduled verification', 'Advanced logs & audit', 'SLA on hosted MCP', 'Priority support'],
    selfServe: false,
  },
];

export default function PricingTable() {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const choose = async (tier: Tier) => {
    if (tier.key === 'free') {
      window.location.href = '/app';
      return;
    }
    // Team/Business aren't self-serve yet (their gated features — vault,
    // custom domain, SLA/audit — don't exist until Phase 3), so route to
    // a contact form instead of selling something that doesn't work.
    if (!tier.selfServe) {
      window.location.href = `mailto:hello@spotcheck.dev?subject=${encodeURIComponent(`${tier.name} plan`)}`;
      return;
    }
    setBusyKey(tier.key);
    setError(null);
    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: tier.key }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not start checkout');
      window.location.href = data.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start checkout');
      setBusyKey(null);
    }
  };

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 }}>
        {TIERS.map((tier) => (
          <div
            key={tier.key}
            className="panel"
            style={{ padding: 20, display: 'grid', gap: 10, ...(tier.featured ? { borderColor: 'var(--accent)' } : {}) }}
          >
            <div style={{ fontSize: 15, fontWeight: 600 }}>{tier.name}</div>
            <div className="mono" style={{ fontSize: 28 }}>
              ${tier.price}
              <small style={{ fontSize: 13, color: 'var(--fg-mute)' }}>/mo</small>
            </div>
            <p style={{ color: 'var(--fg-dim)', fontSize: 13 }}>{tier.blurb}</p>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 6 }}>
              {tier.features.map((f) => (
                <li key={f} style={{ fontSize: 13, color: 'var(--fg-dim)' }}>
                  {f}
                </li>
              ))}
            </ul>
            <button
              type="button"
              className={`btn ${tier.featured ? 'primary' : ''}`}
              onClick={() => choose(tier)}
              disabled={busyKey === tier.key}
            >
              {busyKey === tier.key
                ? 'Redirecting…'
                : tier.key === 'free'
                  ? 'Start free'
                  : tier.selfServe
                    ? `Start ${tier.name}`
                    : 'Talk to us'}
            </button>
          </div>
        ))}
      </div>
      {error && <p style={{ color: 'var(--accent-red)', marginTop: 12, fontSize: 13 }}>{error}</p>}
    </div>
  );
}
