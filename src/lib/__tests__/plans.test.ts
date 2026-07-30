import { describe, expect, it } from 'vitest';
import { can, limitsFor, PLAN_LIMITS } from '../plans';

describe('PLAN_LIMITS', () => {
  it('grants progressively higher API/MCP-call ceilings up the tiers', () => {
    const order: Array<keyof typeof PLAN_LIMITS> = ['free', 'launch', 'pro', 'team', 'business'];
    for (let i = 1; i < order.length; i++) {
      expect(PLAN_LIMITS[order[i]].maxPersistentApis).toBeGreaterThanOrEqual(PLAN_LIMITS[order[i - 1]].maxPersistentApis);
      expect(PLAN_LIMITS[order[i]].mcpCallsPerDay).toBeGreaterThan(PLAN_LIMITS[order[i - 1]].mcpCallsPerDay);
    }
  });

  it('only gates Team+ features behind privateApis/vaultedCredentials/customDomain', () => {
    for (const plan of ['free', 'launch', 'pro'] as const) {
      expect(PLAN_LIMITS[plan].privateApis).toBe(false);
      expect(PLAN_LIMITS[plan].vaultedCredentials).toBe(false);
      expect(PLAN_LIMITS[plan].customDomain).toBe(false);
    }
    for (const plan of ['team', 'business'] as const) {
      expect(PLAN_LIMITS[plan].privateApis).toBe(true);
      expect(PLAN_LIMITS[plan].vaultedCredentials).toBe(true);
      expect(PLAN_LIMITS[plan].customDomain).toBe(true);
    }
  });

  it('only gates auditLogs/scheduledVerification behind Business', () => {
    for (const plan of ['free', 'launch', 'pro', 'team'] as const) {
      expect(PLAN_LIMITS[plan].auditLogs).toBe(false);
      expect(PLAN_LIMITS[plan].scheduledVerification).toBe(false);
    }
    expect(PLAN_LIMITS.business.auditLogs).toBe(true);
    expect(PLAN_LIMITS.business.scheduledVerification).toBe(true);
  });

  // askAssistant spends real LLM tokens on DocentAPI's account, so it follows
  // the same Pro+ floor as analytics rather than being free to anyone who can
  // view the page.
  it('only gates analytics/askAssistant behind Pro+', () => {
    for (const plan of ['free', 'launch'] as const) {
      expect(PLAN_LIMITS[plan].analytics).toBe(false);
      expect(PLAN_LIMITS[plan].askAssistant).toBe(false);
    }
    for (const plan of ['pro', 'team', 'business'] as const) {
      expect(PLAN_LIMITS[plan].analytics).toBe(true);
      expect(PLAN_LIMITS[plan].askAssistant).toBe(true);
    }
  });
});

describe('limitsFor / can', () => {
  it('falls back to free for an unknown plan string', () => {
    expect(limitsFor('nonexistent')).toEqual(PLAN_LIMITS.free);
  });

  it('reflects removeBranding correctly across tiers', () => {
    expect(can('free', 'removeBranding')).toBe(false);
    expect(can('launch', 'removeBranding')).toBe(false);
    expect(can('pro', 'removeBranding')).toBe(true);
    expect(can('team', 'removeBranding')).toBe(true);
  });
});
