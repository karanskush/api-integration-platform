// What a probe is allowed to do, and what has to be true before it may.
//
// Everything the probe engine does today is read-only, and that is enforced by
// each probe filtering on `safety === 'read'` — a rule repeated in five places
// and derived from the HTTP method, which lineagePlan.ts already had to work
// around because `GET /accounts/{id}/close` classifies as a read.
//
// The state-machine map (L2_ENGINE_SPEC §4) cannot be built from reads. It needs
// to create an entity and drive it through its lifecycle, and MASTER_TECHNICAL_
// PLAN §10.2, §12.11 and GAP_ANALYSIS §7.2 all say the same thing about that:
// mutation is permitted only behind an effect classification, an approved and
// tested cleanup contract, and run states that treat unresolved cleanup as
// failure rather than as an afterthought.
//
// This module is that gate. It performs no I/O and executes nothing — it decides.
// Building it is the honest way to stop deferring write probing indefinitely:
// the precondition becomes a thing that exists and can be reviewed, rather than
// a paragraph in a plan.
//
// THE CENTRAL RULE, from §10.2: "Unknown effect classification fails closed
// above R1." An operation we cannot classify is never probed as if it were safe.

import type { Action } from '../ir';

/** §10.2's risk ladder. */
export type RiskClass = 'R0' | 'R1' | 'R2' | 'R3' | 'R4';

const LADDER: RiskClass[] = ['R0', 'R1', 'R2', 'R3', 'R4'];
const rank = (r: RiskClass) => LADDER.indexOf(r);

export type EffectTag =
  | 'creates_resource'
  | 'modifies_resource'
  | 'deletes_resource'
  | 'moves_money'
  | 'sends_message'
  | 'publishes_content'
  | 'changes_identity'
  | 'starts_async_work'
  | 'external_side_effect_unknown';

// Path/name tokens that raise an operation above what its HTTP method suggests.
// This is the same denylist lineagePlan.ts needs, generalised: the method is a
// weak signal and the URL is often a stronger one.
//
// The trailing `s?` is load-bearing. REST collections are plural, so without it
// `/payments` failed to match the token `payment` and a money-movement endpoint
// classified as an ordinary read — the exact failure this list exists to
// prevent.
const CONSEQUENTIAL_TOKENS =
  /(^|[/_-])(delete|remove|purge|destroy|revoke|cancel|close|reset|logout|disable|expire|consume|archive|deactivate|refund|charge|payout|transfer|withdraw|send|email|sms|notify|publish|invite)s?([/_-]|$)/i;

// Tokens that put an operation in R4 outright: money movement, identity, and
// anything a regulator would care about. Never probed by the managed runner.
const IRREVERSIBLE_TOKENS =
  /(^|[/_-])(payment|payout|transfer|withdraw|refund|charge|invoice|subscription|billing|password|credential|token|permission|role|consent|gdpr|pii|patient|medical)s?([/_-]|$)/i;

export type EffectClassification = {
  risk: RiskClass;
  tags: EffectTag[];
  /** Why it landed here, so a provider override is an informed one. */
  basis: 'read_method' | 'path_token' | 'write_method' | 'delete_method' | 'unknown_method';
};

// Path and name are tested SEPARATELY rather than joined. Joining them put a
// space between the two, and a space is not a token boundary in the patterns
// above — so `/accounts/{id}/close` silently failed to match `close`, which is
// the single most important case this classifier exists to catch.
function matchesToken(action: Action, pattern: RegExp): boolean {
  return pattern.test(action.path) || pattern.test(action.name);
}

/**
 * The deterministic default for one operation. §10.2 allows a provider override
 * on top; this is what applies when there is none.
 *
 * Deliberately pessimistic. Being wrong upward costs a probe we could have run;
 * being wrong downward costs somebody's data.
 */
export function classifyEffect(action: Action): EffectClassification {
  const method = action.method.toUpperCase();

  // Risk and effect tags are ORTHOGONAL, and an earlier version conflated them:
  // the token check ran first and returned, so `DELETE /widgets/{id}` named
  // `remove_widget` lost its `deletes_resource` tag to a generic one. The tags
  // describe WHAT the operation does and come from the method; the risk class
  // describes how dangerous that is and can be raised by the path.
  let risk: RiskClass;
  let tags: EffectTag[];
  let basis: EffectClassification['basis'];

  switch (method) {
    case 'GET':
    case 'HEAD':
      risk = 'R1';
      tags = [];
      basis = 'read_method';
      break;
    case 'DELETE':
      risk = 'R3';
      tags = ['deletes_resource'];
      basis = 'delete_method';
      break;
    case 'POST':
      // R2 in §10.2 means "create/update NAMESPACED SANDBOX FIXTURE WITH PROVEN
      // CLEANUP". Without a cleanup contract that is not what this is, so the
      // default is R3 and the contract is what lowers it — see riskWithCleanup.
      risk = 'R3';
      tags = ['creates_resource'];
      basis = 'write_method';
      break;
    case 'PUT':
    case 'PATCH':
      risk = 'R3';
      tags = ['modifies_resource'];
      basis = 'write_method';
      break;
    default:
      // OPTIONS, TRACE, or something we do not model. §10.2: unknown fails
      // closed above R1.
      risk = 'R3';
      tags = ['external_side_effect_unknown'];
      basis = 'unknown_method';
  }

  // The path is the stronger signal where they disagree: `GET /accounts/{id}/close`
  // is a read by method and consequential in fact. Escalation only — a token
  // never LOWERS a risk the method already established.
  if (matchesToken(action, IRREVERSIBLE_TOKENS)) {
    return { risk: 'R4', tags: [...new Set([...tags, 'external_side_effect_unknown' as const])], basis: 'path_token' };
  }
  if (matchesToken(action, CONSEQUENTIAL_TOKENS) && rank(risk) < rank('R3')) {
    return { risk: 'R3', tags: [...new Set([...tags, 'external_side_effect_unknown' as const])], basis: 'path_token' };
  }

  return { risk, tags, basis };
}

/**
 * How a created resource gets cleaned up.
 *
 * GAP_ANALYSIS §7.2 rejects "an inverse operation must exist" as too narrow —
 * an inverse alone does not make mutation safe, and several other mechanisms
 * are equally good. These are the six it names.
 */
export type CleanupMechanism =
  | 'inverse_operation'
  | 'provider_ttl'
  | 'ephemeral_environment_reset'
  | 'approved_cleanup_job'
  | 'reusable_fixture_pool'
  | 'accepted_quarantine';

export type CleanupContract = {
  /**
   * The operation this contract covers, by tool name.
   *
   * Without it, one approved contract would authorise mutation of every
   * operation on the API — §10.2 puts R2 behind "policy approval + cleanup
   * contract" rather than per-operation approval, so the contract IS the
   * per-operation approval at that level and has to name its operation to be
   * worth anything.
   */
  operation: string;
  mechanism: CleanupMechanism;
  /** Approved by a person, per §10.2's "policy approval". */
  approved: boolean;
  /** Exercised at least once — an untested contract is a hope, not a contract. */
  tested: boolean;
  /** Required for accepted_quarantine: who accepted the residual risk. */
  residualRiskAcceptedBy?: string;
};

export type CleanupVerdict = { satisfied: boolean; reason: CleanupDenyReason | 'ok' };

export type CleanupDenyReason =
  | 'no_contract'
  | 'wrong_operation'
  | 'not_approved'
  | 'not_tested'
  | 'quarantine_unaccepted';

export function cleanupSatisfied(contract: CleanupContract | null, operation?: string): CleanupVerdict {
  if (!contract) return { satisfied: false, reason: 'no_contract' };
  if (operation !== undefined && contract.operation !== operation) {
    return { satisfied: false, reason: 'wrong_operation' };
  }
  if (!contract.approved) return { satisfied: false, reason: 'not_approved' };

  // Quarantine is the one mechanism that does not clean anything up: it
  // knowingly leaves the resource behind. That is allowed, but only against a
  // named person's acceptance of the residual risk — otherwise "we'll quarantine
  // it" becomes a way to opt out of cleanup entirely.
  if (contract.mechanism === 'accepted_quarantine') {
    return contract.residualRiskAcceptedBy
      ? { satisfied: true, reason: 'ok' }
      : { satisfied: false, reason: 'quarantine_unaccepted' };
  }

  // Everything else must have been exercised. An inverse operation nobody has
  // run is an assumption about the provider's API, which is exactly the class of
  // assumption this product exists to stop making.
  if (!contract.tested) return { satisfied: false, reason: 'not_tested' };
  return { satisfied: true, reason: 'ok' };
}

/**
 * A create/update drops from R3 to R2 only once cleanup is genuinely in hand —
 * §10.2's R2 row is "create/update namespaced sandbox fixture WITH PROVEN
 * CLEANUP", so the contract is not an extra check beside the class, it is what
 * defines it.
 */
export function riskWithCleanup(
  base: EffectClassification,
  contract: CleanupContract | null,
  operation?: string,
): RiskClass {
  if (base.risk !== 'R3') return base.risk;
  if (base.tags.includes('deletes_resource')) return 'R3'; // a delete is never R2
  return cleanupSatisfied(contract, operation).satisfied ? 'R2' : 'R3';
}

/** What the runner has been authorized to do, per §10.3's immutable policy. */
export type ProbePolicy = {
  environment: 'production' | 'sandbox';
  /** The highest class this runner may execute. */
  maxRisk: RiskClass;
  /** Per-operation approval, required at R3 and above. */
  approvedOperations: ReadonlySet<string>;
  /** Remaining consequential actions this run may take. */
  effectBudget: number;
};

export type ProbeDecision = { allowed: boolean; risk: RiskClass; reason: ProbeDenyReason | 'ok' };

export type ProbeDenyReason =
  | 'above_policy_max'
  | 'r4_never_probed'
  | 'production_mutation'
  | 'not_individually_approved'
  | 'effect_budget_exhausted'
  | 'cleanup_unsatisfied';

/**
 * The gate. Every mutation must pass this before a request is built.
 *
 * Order matters: the most absolute refusals come first, so a denial names the
 * strongest reason rather than an incidental one.
 */
export function mayProbe(
  action: Action,
  policy: ProbePolicy,
  contract: CleanupContract | null = null,
): ProbeDecision {
  const base = classifyEffect(action);
  const risk = riskWithCleanup(base, contract, action.name);
  const deny = (reason: ProbeDenyReason): ProbeDecision => ({ allowed: false, risk, reason });

  // §10.2: R4 is "disabled in managed autonomous probing; customer-controlled
  // validation only". Not a budget question and not overridable here.
  if (risk === 'R4') return deny('r4_never_probed');

  if (rank(risk) > rank(policy.maxRisk)) return deny('above_policy_max');

  // Reads are always fine within the policy ceiling; everything below concerns
  // mutation only.
  if (rank(risk) <= rank('R1')) return { allowed: true, risk, reason: 'ok' };

  // §12.7's own framing: production writes stay outside managed autonomous
  // probing. A sandbox is the only place a fixture can be created and undone.
  if (policy.environment === 'production') return deny('production_mutation');

  if (!cleanupSatisfied(contract, action.name).satisfied) return deny('cleanup_unsatisfied');

  if (rank(risk) >= rank('R3') && !policy.approvedOperations.has(action.name)) {
    return deny('not_individually_approved');
  }

  if (policy.effectBudget <= 0) return deny('effect_budget_exhausted');

  return { allowed: true, risk, reason: 'ok' };
}

/**
 * §12.11: "A run is not `succeeded` while required cleanup is unresolved."
 *
 * The six terminal states encode that a run which created something it could not
 * clean up is a different outcome from one that did not — even when the probing
 * itself went perfectly.
 */
export type RunOutcome = 'completed' | 'failed' | 'canceled';

export type TerminalRunState =
  | 'completed_clean'
  | 'completed_with_quarantined_resources'
  | 'failed_clean'
  | 'failed_with_quarantined_resources'
  | 'canceled_clean'
  | 'canceled_with_quarantined_resources';

export function terminalStateFor(outcome: RunOutcome, quarantinedCount: number): TerminalRunState {
  const suffix = quarantinedCount > 0 ? 'with_quarantined_resources' : 'clean';
  return `${outcome}_${suffix}` as TerminalRunState;
}

/**
 * §12.11: "Public release is blocked by quarantined consequential resources
 * unless an authorized reviewer accepts the exception."
 *
 * Note the word CONSEQUENTIAL: a quarantined R2 fixture in a sandbox does not
 * block a release, while a quarantined R3 resource does. Conflating them would
 * make the block either useless or unusable.
 */
export function releaseBlocked(
  quarantined: Array<{ risk: RiskClass }>,
  reviewerException: boolean,
): { blocked: boolean; consequential: number } {
  const consequential = quarantined.filter((q) => rank(q.risk) >= rank('R3')).length;
  return { blocked: consequential > 0 && !reviewerException, consequential };
}
