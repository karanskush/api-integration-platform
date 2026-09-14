// How the owner's consent becomes the policy the gate evaluates, and how the
// cleanup contract for a family is derived.
//
// Consent is the sandbox credential's `write_consent_at`: one decision that
// covers every reversible family the planner produced. The gate still decides
// per operation — R4 is never probed whatever the consent says, a delete is
// never R2, and an untested contract keeps a create at R3.

import type { ResourceFamily } from './families';
import type { CleanupContract, ProbePolicy, RiskClass } from './policy';

export type WriteConsent = {
  environment: 'sandbox';
  consentedAt: Date | string;
  consentedBy?: string | null;
};

export function policyFromConsent(
  families: ResourceFamily[],
  consent: WriteConsent | null,
  effectBudget: number,
  denylist: RegExp | null = null,
): ProbePolicy {
  if (!consent) {
    return { environment: 'sandbox', maxRisk: 'R1' as RiskClass, approvedOperations: new Set(), effectBudget: 0, denylist };
  }
  const approved = new Set<string>();
  for (const family of families) {
    if (family.skip) continue;
    approved.add(family.create.name);
    if (family.update) approved.add(family.update.name);
    if (family.remove) approved.add(family.remove.name);
  }
  return { environment: 'sandbox', maxRisk: 'R3', approvedOperations: approved, effectBudget, denylist };
}

/**
 * The inverse-operation contract for a family: the create is covered by its
 * own DELETE. `tested` comes from the cleanup_contracts row — false until a
 * run has created, deleted and confirmed the object gone, which is exactly
 * what the first run of every family does (the cleanup rehearsal). Other
 * mechanisms are stored in the same table and executed by later slices.
 */
export function deriveCleanupContract(family: ResourceFamily, tested: boolean): CleanupContract | null {
  if (!family.remove) return null;
  return {
    operation: family.create.name,
    covers: family.update ? [family.update.name] : [],
    mechanism: 'inverse_operation',
    approved: true,
    tested,
  };
}
