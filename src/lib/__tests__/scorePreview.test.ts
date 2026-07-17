import { describe, expect, it } from 'vitest';
import { scorePreview } from '../scorePreview';
import type { Action, ImportRecord } from '../ir';

function action(overrides: Partial<Action> = {}): Action {
  return {
    id: 'a1',
    name: 'get_thing',
    description: 'Get a thing',
    method: 'GET',
    path: '/things/{id}',
    paramsSchema: { type: 'object', properties: {} },
    auth: 'none',
    safety: 'read',
    examples: [],
    ...overrides,
  };
}

function record(overrides: Partial<ImportRecord> = {}): ImportRecord {
  const actions = overrides.actions ?? [action()];
  return {
    id: 'rec1',
    name: 'Test API',
    source: 'openapi',
    baseUrls: ['https://api.example.com'],
    auth: 'bearer',
    actions,
    counts: {
      total: actions.length,
      read: actions.filter((a) => a.safety === 'read').length,
      write: actions.filter((a) => a.safety === 'write').length,
      destructive: actions.filter((a) => a.safety === 'destructive').length,
    },
    createdAt: 0,
    expiresAt: 0,
    ...overrides,
  };
}

describe('scorePreview', () => {
  it('scores a clean API at 100', () => {
    const result = scorePreview(record());
    expect(result.total).toBe(100);
    expect(result.checks).toHaveLength(4);
    for (const c of result.checks) expect(c.points).toBe(c.maxPoints);
  });

  it('gives full auth credit for none/bearer/basic, and a resolvable apiKey', () => {
    expect(scorePreview(record({ auth: 'none' })).checks[0].points).toBe(25);
    expect(scorePreview(record({ auth: 'bearer' })).checks[0].points).toBe(25);
    expect(scorePreview(record({ auth: 'basic' })).checks[0].points).toBe(25);
    expect(
      scorePreview(record({ auth: 'apiKey', authIn: { in: 'header', name: 'X-Api-Key' } })).checks[0].points,
    ).toBe(25);
  });

  it('penalizes apiKey auth with unresolved placement', () => {
    const check = scorePreview(record({ auth: 'apiKey' })).checks[0];
    expect(check.points).toBeLessThan(25);
    expect(check.points).toBeGreaterThan(0);
  });

  it('penalizes oauth2 more than an unresolved apiKey (not headlessly satisfiable)', () => {
    const oauth = scorePreview(record({ auth: 'oauth2' })).checks[0];
    const apiKey = scorePreview(record({ auth: 'apiKey' })).checks[0];
    expect(oauth.points).toBeLessThan(apiKey.points);
  });

  it('zeroes the base-URL check when no base URL was found', () => {
    const check = scorePreview(record({ baseUrls: [] })).checks[1];
    expect(check.points).toBe(0);
  });

  it('penalizes a high destructive ratio', () => {
    const actions = [
      action({ id: 'a1', name: 'get_a', safety: 'read' }),
      action({ id: 'a2', name: 'delete_a', safety: 'destructive' }),
      action({ id: 'a3', name: 'delete_b', safety: 'destructive' }),
    ];
    const check = scorePreview(record({ actions })).checks[2];
    expect(check.points).toBeLessThan(25);
    expect(check.message).toContain('destructive');
  });

  it('flags collision-suffixed and generic-fallback tool names', () => {
    const actions = [
      action({ id: 'a1', name: 'get_pet' }),
      action({ id: 'a2', name: 'get_pet_2' }),
      action({ id: 'a3', name: 'get_root' }),
    ];
    const check = scorePreview(record({ actions })).checks[3];
    expect(check.points).toBeLessThan(25);
    expect(check.message).toContain('2/3');
  });

  it('handles a record with zero actions without throwing', () => {
    const result = scorePreview(record({ actions: [], counts: { total: 0, read: 0, write: 0, destructive: 0 } }));
    expect(result.total).toBe(50); // auth + base-URL checks are unaffected by action count; the other two zero out
    expect(result.checks[2].points).toBe(0);
    expect(result.checks[3].points).toBe(0);
  });

  it('never returns a total outside 0-100', () => {
    const result = scorePreview(record());
    expect(result.total).toBeGreaterThanOrEqual(0);
    expect(result.total).toBeLessThanOrEqual(100);
  });
});
