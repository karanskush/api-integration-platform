import { describe, expect, it } from 'vitest';
import { getScoreExplanation as rawGetScoreExplanation } from '../score';
import type { AdvisorContext } from '../types';
import { ctx, petstoreActions, type Payload } from './fixtures';

const getScoreExplanation = (c: AdvisorContext): Payload => rawGetScoreExplanation(c);

const verified = {
  total: 82,
  authClarity: 25,
  errorQuality: 20,
  docDrift: null,
  idempotency: 15,
  explanation: [{ factId: 'fact-1', message: 'Auth clarity: a request without valid bearer credentials was rejected with 401' }],
  verifiedAt: '2026-07-20T10:00:00.000Z',
};

describe('getScoreExplanation', () => {
  it('labels a preview as unverified and says why it is limited', () => {
    const res = getScoreExplanation(ctx(petstoreActions()));
    expect(res.verified).toBe(false);
    expect(res.basis).toContain('static analysis');
    expect(res.note).toContain('not a verified score');
    expect(res.checks?.length).toBe(4);
  });

  it('returns every preview check with its own finding', () => {
    const res = getScoreExplanation(ctx(petstoreActions()));
    for (const check of res.checks ?? []) {
      expect(check.finding.length).toBeGreaterThan(0);
      expect(check.outOf).toBe(25);
    }
  });

  it('labels a live-probed score as verified and dates it', () => {
    const res = getScoreExplanation(ctx(petstoreActions(), { verified }));
    expect(res.verified).toBe(true);
    expect(res.basis).toContain('live probes');
    expect(res.verifiedAt).toBe('2026-07-20T10:00:00.000Z');
    expect(res.total).toBe(82);
  });

  it('explains an unprobeable sub-score instead of scoring it zero', () => {
    const res = getScoreExplanation(ctx(petstoreActions(), { verified }));
    expect(res.subscores?.docDrift).toMatchObject({ score: null, outOf: 25 });
    expect(res.subscores?.docDrift.note).toContain('Excluded from the total');
    expect(res.scoring).toContain('renormalized');
  });

  it('gives every sub-score a plain-language meaning', () => {
    const res = getScoreExplanation(ctx(petstoreActions(), { verified }));
    for (const key of ['authClarity', 'errorQuality', 'docDrift', 'idempotency'] as const) {
      expect(res.subscores?.[key].meaning.length).toBeGreaterThan(10);
    }
  });

  it('points each verified finding at its stored evidence fact', () => {
    const res = getScoreExplanation(ctx(petstoreActions(), { verified }));
    expect(res.evidence).toEqual([
      { factId: 'fact-1', finding: expect.stringContaining('rejected with 401') },
    ]);
  });

  it('bands the total into an interpretation', () => {
    const high = getScoreExplanation(ctx(petstoreActions(), { verified: { ...verified, total: 95 } }));
    const low = getScoreExplanation(ctx(petstoreActions(), { verified: { ...verified, total: 10 } }));
    expect(high.interpretation).toContain('excellent');
    expect(low.interpretation).toContain('poor');
  });

  it('bands every reachable score without falling through', () => {
    for (const total of [0, 34, 35, 54, 55, 74, 75, 89, 90, 100]) {
      const res = getScoreExplanation(ctx(petstoreActions(), { verified: { ...verified, total } }));
      expect(res.interpretation).toBeTruthy();
    }
  });
});
