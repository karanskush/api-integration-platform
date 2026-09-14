// Headers observed on a live probe response becoming evidence. The rate-limit
// policy rides the same path as Deprecation / Sunset, through the same four
// call sites — so any probe that sees a response can be the one that sees it.

import { describe, expect, it } from 'vitest';
import { dedupeLifecycleEvidence, lifecycleEvidence } from '../lifecycle';
import type { Action } from '../../ir';

const action = {
  id: 'a1',
  name: 'list_pets',
  description: 'x',
  method: 'GET',
  path: '/pets',
  paramsSchema: { type: 'object', properties: {} },
  auth: 'none',
  safety: 'read',
  examples: [],
} as Action;

describe('a rate-limit policy on a live response', () => {
  it('becomes a probe.rate_limit fact carrying the policy and never the position', () => {
    const facts = lifecycleEvidence(action, {
      'ratelimit-policy': '"default";q=100;w=60',
      ratelimit: '"default";r=42;t=17',
    });
    const rl = facts.filter((f) => f.kind === 'probe.rate_limit');

    expect(rl).toHaveLength(1);
    expect(rl[0].actionId).toBe('a1');
    expect(rl[0].payload).toMatchObject({ actionId: 'a1', tool: 'list_pets', name: 'default', limit: 100, windowSeconds: 60 });
    expect(JSON.stringify(rl[0].payload)).not.toContain('42');
  });

  it('is emitted alongside, not instead of, a lifecycle signal', () => {
    const facts = lifecycleEvidence(action, { sunset: 'Wed, 01 Jan 2027 00:00:00 GMT', 'x-ratelimit-limit': '500' });
    expect(facts.map((f) => f.kind).sort()).toEqual(['probe.lifecycle_signal', 'probe.rate_limit']);
  });

  it('is absent when no rate-limit header was seen', () => {
    expect(lifecycleEvidence(action, { deprecation: 'true' }).some((f) => f.kind === 'probe.rate_limit')).toBe(false);
    expect(lifecycleEvidence(action, undefined)).toEqual([]);
  });

  // Two probes hit the same operation in one run and see the same header.
  it('is deduplicated across probes like a lifecycle signal is', () => {
    const once = lifecycleEvidence(action, { 'ratelimit-policy': '"d";q=10;w=1' });
    const deduped = dedupeLifecycleEvidence([...once, ...once]);
    expect(deduped.filter((f) => f.kind === 'probe.rate_limit')).toHaveLength(1);
  });
});
