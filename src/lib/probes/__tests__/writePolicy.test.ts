// Consent becomes policy; the family's DELETE becomes the contract.
import { describe, expect, it } from 'vitest';
import type { Action } from '../../ir';
import type { ResourceFamily } from '../families';
import { mayProbe } from '../policy';
import { deriveCleanupContract, policyFromConsent } from '../writePolicy';

const act = (name: string, method: string, path: string): Action =>
  ({ id: `id_${name}`, name, description: '', method, path, paramsSchema: { type: 'object', properties: {} }, auth: 'bearer', safety: 'write', examples: [] }) as Action;

const family = (overrides: Partial<ResourceFamily> = {}): ResourceFamily => ({
  entity: 'tag',
  collectionPath: '/tags',
  create: act('create_tag', 'POST', '/tags'),
  read: act('get_tag', 'GET', '/tags/{id}'),
  update: act('update_tag', 'PATCH', '/tags/{id}'),
  remove: act('delete_tag', 'DELETE', '/tags/{id}'),
  idParam: 'id',
  idFieldCandidates: ['response.id'],
  risk: 'R3',
  skip: null,
  ...overrides,
});

describe('policyFromConsent', () => {
  it('without consent nothing above a read is approved', () => {
    const policy = policyFromConsent([family()], null, 6);
    expect(policy.maxRisk).toBe('R1');
    expect(policy.approvedOperations.size).toBe(0);
    expect(mayProbe(family().create, policy, null).allowed).toBe(false);
  });

  it('with consent every operation of a runnable family is approved, in the sandbox only', () => {
    const policy = policyFromConsent([family()], { environment: 'sandbox', consentedAt: new Date() }, 6);
    expect(policy.environment).toBe('sandbox');
    expect([...policy.approvedOperations].sort()).toEqual(['create_tag', 'delete_tag', 'update_tag']);
    expect(policy.effectBudget).toBe(6);
  });

  it('a skipped family is not approved even with consent', () => {
    const policy = policyFromConsent([family({ skip: 'no_delete', remove: null })], { environment: 'sandbox', consentedAt: new Date() }, 6);
    expect(policy.approvedOperations.size).toBe(0);
  });

  it('the gate still refuses an untested contract at R3 when the policy caps at R2', () => {
    const policy = { ...policyFromConsent([family()], { environment: 'sandbox', consentedAt: new Date() }, 6), maxRisk: 'R2' as const };
    expect(mayProbe(family().create, policy, deriveCleanupContract(family(), false)).allowed).toBe(false);
    expect(mayProbe(family().create, policy, deriveCleanupContract(family(), true)).allowed).toBe(true);
  });
});

describe('deriveCleanupContract', () => {
  it('is the inverse operation, keyed by the create', () => {
    expect(deriveCleanupContract(family(), true)).toEqual({ operation: 'create_tag', covers: ['update_tag'], mechanism: 'inverse_operation', approved: true, tested: true });
  });

  it('does not exist without a DELETE', () => {
    expect(deriveCleanupContract(family({ remove: null }), true)).toBeNull();
  });
});
