// The gate that has to exist before any probe may mutate anything.
//
// Nothing in the product calls this to write yet — that is the point. The
// state-machine map has been deferred on "there is no probe policy", and this
// turns that from a paragraph in a plan into something reviewable. The tests
// below are mostly about what it REFUSES.

import { describe, expect, it } from 'vitest';
import {
  classifyEffect,
  cleanupSatisfied,
  mayProbe,
  releaseBlocked,
  riskWithCleanup,
  terminalStateFor,
  type CleanupContract,
  type ProbePolicy,
} from '../policy';
import type { Action } from '../../ir';

function action(overrides: Partial<Action> & { name: string; path: string }): Action {
  return {
    id: `id_${overrides.name}`,
    description: 'x',
    method: 'GET',
    paramsSchema: { type: 'object', properties: {} },
    auth: 'bearer',
    safety: 'read',
    examples: [],
    ...overrides,
  } as Action;
}

const sandbox = (over: Partial<ProbePolicy> = {}): ProbePolicy => ({
  environment: 'sandbox',
  maxRisk: 'R3',
  approvedOperations: new Set(['create_widget']),
  effectBudget: 5,
  ...over,
});

const goodContract: CleanupContract = {
  operation: 'create_widget',
  mechanism: 'inverse_operation',
  approved: true,
  tested: true,
};

describe('effect classification', () => {
  it('calls a plain read R1', () => {
    expect(classifyEffect(action({ name: 'list_widgets', path: '/widgets' })).risk).toBe('R1');
  });

  // The failure lineagePlan.ts already had to work around: the method says read,
  // the URL says otherwise, and the URL is right.
  it('raises a read whose path is consequential', () => {
    const close = action({ name: 'close_account', path: '/accounts/{id}/close' });
    const result = classifyEffect(close);
    expect(result.risk).toBe('R3');
    expect(result.basis).toBe('path_token');
  });

  it('puts money and identity in R4 regardless of method', () => {
    expect(classifyEffect(action({ name: 'list_payments', path: '/payments' })).risk).toBe('R4');
    expect(classifyEffect(action({ name: 'get_password_policy', path: '/password/policy' })).risk).toBe('R4');
  });

  it('calls a create R3 until cleanup says otherwise', () => {
    const create = action({ name: 'create_widget', path: '/widgets', method: 'POST', safety: 'write' });
    expect(classifyEffect(create).risk).toBe('R3');
    expect(classifyEffect(create).tags).toContain('creates_resource');
  });

  it('tags a delete and never lets it drop below R3', () => {
    const del = action({ name: 'remove_widget', path: '/widgets/{id}', method: 'DELETE', safety: 'destructive' });
    const base = classifyEffect(del);
    expect(base.tags).toContain('deletes_resource');
    // Cleanup cannot make a deletion reversible.
    expect(riskWithCleanup(base, goodContract)).toBe('R3');
  });

  // §10.2, verbatim: "Unknown effect classification fails closed above R1."
  it('fails closed on a method it does not model', () => {
    const odd = action({ name: 'probe_widget', path: '/widgets', method: 'TRACE' });
    const result = classifyEffect(odd);
    expect(result.risk).toBe('R3');
    expect(result.basis).toBe('unknown_method');
  });
});

describe('the cleanup contract', () => {
  it('is not satisfied by its absence', () => {
    expect(cleanupSatisfied(null)).toEqual({ satisfied: false, reason: 'no_contract' });
  });

  it('requires approval', () => {
    expect(cleanupSatisfied({ ...goodContract, approved: false }).reason).toBe('not_approved');
  });

  // An inverse operation nobody has run is an assumption about the provider's
  // API — exactly the class of assumption this product exists to stop making.
  it('requires the mechanism to have been exercised', () => {
    expect(cleanupSatisfied({ ...goodContract, tested: false }).reason).toBe('not_tested');
  });

  it('accepts any of the six mechanisms once approved and tested', () => {
    for (const mechanism of [
      'inverse_operation',
      'provider_ttl',
      'ephemeral_environment_reset',
      'approved_cleanup_job',
      'reusable_fixture_pool',
    ] as const) {
      expect(cleanupSatisfied({ operation: 'create_widget', mechanism, approved: true, tested: true }).satisfied).toBe(true);
    }
  });

  // Quarantine cleans nothing up — it knowingly leaves the resource behind.
  // Allowed, but only against a named acceptance, or "we'll quarantine it"
  // becomes a way to opt out of cleanup entirely.
  it('requires a named person to accept a quarantine', () => {
    const quarantine: CleanupContract = {
      operation: 'create_widget',
      mechanism: 'accepted_quarantine',
      approved: true,
      tested: false,
    };
    expect(cleanupSatisfied(quarantine).reason).toBe('quarantine_unaccepted');
    expect(cleanupSatisfied({ ...quarantine, residualRiskAcceptedBy: 'ops@acme.test' }).satisfied).toBe(true);
  });

  it('lowers a create to R2 only with cleanup in hand', () => {
    const create = classifyEffect(action({ name: 'create_widget', path: '/widgets', method: 'POST', safety: 'write' }));
    expect(riskWithCleanup(create, null)).toBe('R3');
    expect(riskWithCleanup(create, goodContract)).toBe('R2');
  });
});

describe('mayProbe — what it refuses', () => {
  const create = action({ name: 'create_widget', path: '/widgets', method: 'POST', safety: 'write' });

  it('allows a read within the ceiling', () => {
    const read = action({ name: 'list_widgets', path: '/widgets' });
    expect(mayProbe(read, sandbox()).allowed).toBe(true);
  });

  it('never probes R4, whatever the policy says', () => {
    const money = action({ name: 'create_payout', path: '/payouts', method: 'POST', safety: 'write' });
    const permissive = sandbox({ maxRisk: 'R4', approvedOperations: new Set(['create_payout']), effectBudget: 99 });

    expect(mayProbe(money, permissive, goodContract)).toMatchObject({ allowed: false, reason: 'r4_never_probed' });
  });

  // §12.7's own rule: production writes stay outside managed autonomous probing.
  it('never mutates production, even with a perfect contract and approval', () => {
    const prod = sandbox({ environment: 'production', approvedOperations: new Set(['create_widget']) });
    expect(mayProbe(create, prod, goodContract)).toMatchObject({ allowed: false, reason: 'production_mutation' });
  });

  it('refuses a mutation with no cleanup contract', () => {
    expect(mayProbe(create, sandbox(), null).reason).toBe('cleanup_unsatisfied');
  });

  // A contract for a DIFFERENT operation must not authorise this one, or one
  // approval would unlock mutation across the whole API.
  it('refuses a mutation whose contract names another operation', () => {
    const wrong = { ...goodContract, operation: 'create_gadget' };
    expect(mayProbe(create, sandbox(), wrong).reason).toBe('cleanup_unsatisfied');
  });

  it('refuses an R3 mutation the policy did not individually approve', () => {
    // No contract, so it stays R3 — where per-operation approval is required.
    const unapproved = sandbox({ approvedOperations: new Set(), maxRisk: 'R3' });
    const decision = mayProbe(create, unapproved, null);
    expect(decision.allowed).toBe(false);
  });

  it('refuses once the effect budget is spent', () => {
    // Approved, contracted, in a sandbox — and still refused, because budget is
    // the last thing standing between one fixture and a thousand.
    const spent = sandbox({ effectBudget: 0 });
    expect(mayProbe(create, spent, goodContract).reason).toBe('effect_budget_exhausted');
  });

  it('refuses anything above the policy ceiling', () => {
    const readOnly = sandbox({ maxRisk: 'R1' });
    expect(mayProbe(create, readOnly, goodContract).reason).toBe('above_policy_max');
  });

  it('allows a create only when every condition holds at once', () => {
    expect(mayProbe(create, sandbox(), goodContract)).toEqual({ allowed: true, risk: 'R2', reason: 'ok' });
  });

  // Today's read-only engine must still pass its own gate.
  it('permits everything the current read-only probes already do', () => {
    const readOnlyPolicy = sandbox({ environment: 'production', maxRisk: 'R1' });
    for (const path of ['/pets', '/pets/{petId}', '/store/inventory', '/users/{username}']) {
      expect(mayProbe(action({ name: `get_${path}`, path }), readOnlyPolicy).allowed).toBe(true);
    }
  });
});

describe('cleanup is part of correctness', () => {
  it('names all six terminal states', () => {
    expect(terminalStateFor('completed', 0)).toBe('completed_clean');
    expect(terminalStateFor('completed', 2)).toBe('completed_with_quarantined_resources');
    expect(terminalStateFor('failed', 0)).toBe('failed_clean');
    expect(terminalStateFor('failed', 1)).toBe('failed_with_quarantined_resources');
    expect(terminalStateFor('canceled', 0)).toBe('canceled_clean');
    expect(terminalStateFor('canceled', 3)).toBe('canceled_with_quarantined_resources');
  });

  // A run that created something it could not clean up is a different outcome
  // from one that did not, even when the probing itself went perfectly.
  it('does not let a perfect run hide a resource it stranded', () => {
    expect(terminalStateFor('completed', 1)).not.toBe('completed_clean');
  });
});

describe('release blocking', () => {
  it('blocks on a stranded consequential resource', () => {
    expect(releaseBlocked([{ risk: 'R3' }], false)).toEqual({ blocked: true, consequential: 1 });
  });

  // The distinction is load-bearing: conflating a sandbox fixture with a
  // consequential resource makes the block either useless or unusable.
  it('does not block on a stranded sandbox fixture', () => {
    expect(releaseBlocked([{ risk: 'R2' }, { risk: 'R1' }], false).blocked).toBe(false);
  });

  it('lets an authorized reviewer accept the exception', () => {
    expect(releaseBlocked([{ risk: 'R3' }], true).blocked).toBe(false);
  });

  it('reports nothing to block on when nothing was stranded', () => {
    expect(releaseBlocked([], false)).toEqual({ blocked: false, consequential: 0 });
  });
});
