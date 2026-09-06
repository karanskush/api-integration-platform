import { describe, expect, it } from 'vitest';
import type { ChangeRow } from '../../changes/ledger';
import type { ChangeSummary } from '../../changes/query';
import { checkFreshness as rawCheckFreshness, getChangesSince as rawGetChangesSince } from '../changes';
import type { AdvisorContext } from '../types';
import { ctx, petstoreActions, type Payload } from './fixtures';

const getChangesSince = (c: AdvisorContext, args: Record<string, unknown> = {}): Payload =>
  rawGetChangesSince(c, args) as Payload;
const checkFreshness = (c: AdvisorContext): Payload => rawCheckFreshness(c) as Payload;

const NOW = Date.now();
const daysAgo = (n: number) => new Date(NOW - n * 24 * 3600 * 1000).toISOString();

function change(overrides: Partial<ChangeRow> = {}): ChangeRow {
  return {
    id: `id-${Math.random()}`,
    kind: 'field.removed',
    severity: 'breaking',
    source: 'poll',
    actionKey: 'a1',
    tool: 'get_pet',
    method: 'GET',
    path: '/pets/{petId}',
    fieldPath: 'response.name',
    location: 'response',
    summary: 'get_pet response field response.name removed',
    detail: {},
    fromSpecVersionId: null,
    toSpecVersionId: 'v2',
    toContentHash: 'abc123def456789',
    observedAt: daysAgo(1),
    ...overrides,
  };
}

function summary(overrides: Partial<ChangeSummary> = {}): ChangeSummary {
  return {
    counts30d: { breaking: 1, risky: 0, additive: 2, cosmetic: 0 },
    total30d: 3,
    lastChangeAt: daysAgo(1),
    lastCheckedAt: daysAgo(0),
    lastSpecChangeAt: daysAgo(1),
    currentSpecVersionId: 'v2',
    currentVersionHash: 'abc123def456789',
    ...overrides,
  };
}

function withChanges(recent: ChangeRow[], s: ChangeSummary | null = summary()) {
  return ctx(petstoreActions(), { changes: { recent, summary: s } });
}

describe('getChangesSince', () => {
  it('defaults to the last 30 days and reports the worst severity found', () => {
    const res = getChangesSince(withChanges([change(), change({ severity: 'additive', summary: 'added' })]));
    expect(res.basis).toContain('30 days');
    expect(res.count).toBe(2);
    expect(res.highest).toBe('breaking');
    expect(res.changes[0].summary).toContain('removed');
  });

  it('excludes anything older than the window', () => {
    const res = getChangesSince(withChanges([change({ observedAt: daysAgo(90) })]));
    expect(res.count).toBe(0);
    expect(res.note).toContain('none were detected, not that none happened');
  });

  it('accepts an ISO since and filters to it', () => {
    const res = getChangesSince(
      withChanges([change({ observedAt: daysAgo(1), summary: 'new' }), change({ observedAt: daysAgo(10), summary: 'old' })]),
      { since: daysAgo(5) },
    );
    expect(res.changes.map((c: Record<string, unknown>) => c.summary)).toEqual(['new']);
  });

  // A consumer knows which spec version it integrated against, not the date.
  it('accepts a spec-version hash prefix', () => {
    const res = getChangesSince(withChanges([change({ toContentHash: 'abc123def456789' })]), { since: 'abc123' });
    expect(res.basis).toContain('abc123def456');
    expect(res.count).toBe(1);
  });

  it('says so rather than guessing when the hash prefix is not in the loaded history', () => {
    const res = getChangesSince(withChanges([change()]), { since: 'ffffff' });
    expect(res.error).toContain('No change in the recorded history');
  });

  it('rejects an unparseable since and an unknown severity', () => {
    expect(getChangesSince(withChanges([change()]), { since: 'last tuesday' }).error).toContain('ISO timestamp');
    expect(getChangesSince(withChanges([change()]), { severity: 'catastrophic' }).error).toContain('severity must be');
  });

  it('filters by severity', () => {
    const res = getChangesSince(withChanges([change({ severity: 'breaking' }), change({ severity: 'additive' })]), {
      severity: 'additive',
    });
    expect(res.count).toBe(1);
    expect(res.changes[0].severity).toBe('additive');
  });

  it('bounds the result and reports that it truncated', () => {
    const many = Array.from({ length: 120 }, () => change());
    const res = getChangesSince(withChanges(many), { limit: 500 });
    expect(res.count).toBe(100);
    expect(res.truncated).toBe(true);
  });

  it('tolerates junk arguments rather than throwing', () => {
    const res = getChangesSince(withChanges([change()]), { since: 42, severity: [], limit: 'lots' });
    expect(res.count).toBe(1);
  });

  // An ephemeral import has no ledger; saying "no changes" would imply we
  // looked and found none.
  it('labels an ephemeral import explicitly instead of reporting zero changes', () => {
    const res = getChangesSince(withChanges([], null));
    expect(res.changes).toEqual([]);
    expect(res.basis).toContain('no stored change history');
    expect(res.note).toContain('ephemeral');
  });

  it('says how each change was detected', () => {
    const res = getChangesSince(withChanges([change({ source: 'header', summary: 'sunset announced' })]));
    expect(res.changes[0].source).toBe('header');
  });
});

describe('checkFreshness', () => {
  it('reports the current version, when it was last checked, and a tool fingerprint', () => {
    const res = checkFreshness(withChanges([change()]));
    expect(res.specVersion).toBe('abc123def456');
    expect(res.lastCheckedAt).toBeTruthy();
    expect(res.changes30d).toEqual({ breaking: 1, risky: 0, additive: 2, cosmetic: 0 });
    expect(res.toolFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(res.toolCount).toBeGreaterThan(0);
  });

  it('is stable across calls for an unchanged API', () => {
    const context = withChanges([change()]);
    expect(checkFreshness(context).toolFingerprint).toBe(checkFreshness(context).toolFingerprint);
  });

  // The drift this tool exists to make visible: a schema moves, the
  // description does not, and no MCP client re-prompts.
  it('changes the fingerprint when an operation schema changes without its description', () => {
    const before = checkFreshness(withChanges([change()])).toolFingerprint;

    const actions = petstoreActions();
    const target = actions[0];
    const reshaped = {
      ...target,
      paramsSchema: { ...target.paramsSchema, properties: { ...(target.paramsSchema.properties as object), added: { type: 'string' } } },
    };
    const after = checkFreshness(
      ctx([reshaped, ...actions.slice(1)], { changes: { recent: [change()], summary: summary() } }),
    ).toolFingerprint;

    expect(after).not.toBe(before);
  });

  it('surfaces a stale verified score rather than only the number', () => {
    const context = ctx(petstoreActions(), {
      changes: { recent: [], summary: summary() },
      verified: {
        total: 82,
        authClarity: 25,
        errorQuality: 20,
        docDrift: null,
        idempotency: 15,
        explanation: [],
        verifiedAt: daysAgo(3),
        stale: true,
        specVersionId: 'v1',
      },
    });
    expect(checkFreshness(context).verified).toMatchObject({ total: 82, stale: true });
  });

  it('labels an ephemeral import and still returns a usable fingerprint', () => {
    const res = checkFreshness(withChanges([], null));
    expect(res.basis).toContain('ephemeral');
    expect(res.specVersion).toBeNull();
    expect(res.toolFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});
