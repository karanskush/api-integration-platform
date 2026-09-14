// The write lifecycle: create → read back → update → read back → delete →
// read back → garbage-collect, on the owner's SANDBOX, through the policy gate,
// with cleanup as correctness.
//
// What it learns is what no spec can say: whether a created object is readable
// at once or after a wait, whether the response matches the documented schema,
// which fields the server fills in, whether an update is reflected, and what a
// deleted object answers (404, 410, a soft-delete flag, or — the finding that
// matters most — still readable). Slice 5 adds the idempotency experiment and
// state transitions on the same skeleton.
//
// THE RULES, each of which a test pins:
//   * mayProbe() runs before EVERY mutating request, never once per family;
//   * an object the runner cannot identify (no id in the body, no Location) is
//     quarantined on the spot and its family stops — nothing can clean it up;
//   * a leak cap per entity and a cleanup reserve on the request budget stop
//     experiments before cleanup would be starved (RESTler's garbage collector,
//     made concrete);
//   * the run aborts on the first 429 and still garbage-collects;
//   * every identifier read from a response is a ValueRef, lives in this
//     function's closure, and reaches the result only sealed by writeRun.ts;
//   * the outcome is not "succeeded" while any created object is unresolved.

import { inferShape } from '../changes/observation';
import type { EvidenceFactInput } from '../evidence';
import { fieldMapFor } from '../fieldMap';
import type { Action } from '../ir';
import { selectValues } from '../lineageExtract';
import type { invokeAction } from '../mcpTools';
import { fillParams } from '../paramFill';
import { validateResponse } from '../responseValidate';
import type { ValueRef } from '../transient';
import { bodyParamName, synthesizeCreateBody, synthesizeUpdateBody, type BodyFailure } from './bodySynth';
import type { EffectBudget } from './budget';
import { callProbe } from './context';
import type { FamilySkip, ResourceFamily } from './families';
import { lifecycleEvidence } from './lifecycle';
import { mayProbe, type ProbeDenyReason, type ProbePolicy, type RunOutcome } from './policy';
import { deriveCleanupContract } from './writePolicy';
import type { ProbeContext } from './types';

export type WriteAbortReason =
  | 'rate_limited'
  | 'budget_exhausted'
  | 'deadline_exceeded'
  | 'effect_budget_exhausted'
  | 'cleanup_reserve_reached';

export type CleanupStatus = 'deleted_confirmed' | 'deleted_unconfirmed' | 'delete_failed' | 'quarantined' | 'not_created';
export type UseAfterFree = 'gone_404' | 'gone_410' | 'soft_deleted' | 'still_readable' | 'not_attempted';
export type Convergence = 'immediate' | 'after_poll' | 'never' | 'not_attempted';
export type IdSource = 'body' | 'location' | 'unavailable';

export type FamilySkipReason = FamilySkip | ProbeDenyReason | BodyFailure | 'leak_cap_reached' | 'cleanup_reserve_reached' | 'params_unfillable' | 'aborted';

/** One created object, as the persistence layer needs it. `ref` is the only place the id exists. */
export type CreatedResource = {
  entity: string;
  createActionKey: string;
  deleteActionKey: string | null;
  ref: ValueRef | null;
  idSource: IdSource;
  cleanup: CleanupStatus;
  deleteStatus: number | null;
  readbackStatus: number | null;
};

export type FamilyObservation = {
  entity: string;
  createTool: string;
  createActionKey: string;
  skipped: FamilySkipReason | null;
  steps: {
    create: number | null;
    read: number | null;
    update: number | null;
    readAfterUpdate: number | null;
    delete: number | null;
    readAfterDelete: number | null;
  };
  idSource: IdSource | null;
  convergence: Convergence;
  pollCount: number;
  schemaValid: boolean | null;
  unknownFieldCount: number | null;
  serverGeneratedFieldCount: number | null;
  updateReflected: boolean | null;
  useAfterFree: UseAfterFree;
  cleanup: CleanupStatus;
  requests: number;
};

export type WriteRunResult = {
  families: FamilyObservation[];
  resources: CreatedResource[];
  evidence: EvidenceFactInput[];
  requestsMade: number;
  effectsUsed: number;
  created: number;
  deletedConfirmed: number;
  /** Created objects whose cleanup is unresolved — what §12.11 counts. */
  quarantined: number;
  aborted: WriteAbortReason | null;
  outcome: RunOutcome;
  /** Create tools whose object was created, deleted and confirmed gone this run: their contracts are now tested. */
  contractsRehearsed: string[];
};

export type WriteRunOptions = {
  runId: string;
  /** create tool name → whether its cleanup contract has been rehearsed. */
  contracts: Map<string, boolean>;
  effects: EffectBudget;
  /** Live (unresolved) objects per entity already in the ledger for this API and environment. */
  liveObjectsByEntity?: Map<string, number>;
  /** An invoke composed WITHOUT the effect budget, for cleanup. Defaults to ctx.invoke. */
  cleanupInvoke?: typeof invokeAction;
  sleep?: (ms: number) => Promise<void>;
  maxFamilies?: number;
  leakCap?: number;
};

export const MAX_FAMILIES = 3;
export const MAX_OBJECTS_PER_RESOURCE_TYPE = 3;
const POLL_DELAYS_MS = [1_000, 2_000];
const SOFT_DELETE = /deleted|removed|archived|trashed/i;

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Every documented response path, containers included, in the same
// `response.<field>` spelling inferShape() uses — so the two sets compare
// directly and only fields the spec never mentions count as unknown.
function documentedPaths(action: Action): Set<string> | null {
  if (!action.responseSchema) return null;
  return new Set(fieldMapFor(action).response.map((f) => f.path));
}

function topLevelKeys(value: unknown): Set<string> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? new Set(Object.keys(value as object)) : new Set();
}

function softDeleted(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const record = body as Record<string, unknown>;
  if (record.deleted === true || record.is_deleted === true || record.archived === true) return true;
  for (const key of ['status', 'state', 'lifecycle']) {
    const v = record[key];
    if (typeof v === 'string' && SOFT_DELETE.test(v)) return true;
  }
  return false;
}

export async function runWriteLifecycle(
  ctx: ProbeContext,
  families: ResourceFamily[],
  policy: ProbePolicy,
  opts: WriteRunOptions,
): Promise<WriteRunResult> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxFamilies = opts.maxFamilies ?? MAX_FAMILIES;
  const leakCap = opts.leakCap ?? MAX_OBJECTS_PER_RESOURCE_TYPE;
  const live = new Map(opts.liveObjectsByEntity ?? []);
  const gcCtx: ProbeContext = { ...ctx, invoke: opts.cleanupInvoke ?? ctx.invoke };

  const observations: FamilyObservation[] = [];
  const resources: CreatedResource[] = [];
  const evidence: EvidenceFactInput[] = [];
  const rehearsed: string[] = [];
  let requestsMade = 0;
  let aborted: WriteAbortReason | null = null;
  let liveCreatedThisRun = 0;

  // Every outbound call of the run goes through here: counts, keeps headers,
  // turns a 429 or a spent budget into an abort that the loops observe.
  const call = async (
    who: ProbeContext,
    action: Action,
    params: Record<string, unknown>,
    extra: { captureLocation?: boolean } = {},
  ) => {
    requestsMade++;
    try {
      const res = await callProbe(who, action, params, extra);
      evidence.push(...lifecycleEvidence(action, res.headers));
      if (res.status === 429) aborted = aborted ?? 'rate_limited';
      return res;
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'BudgetExhaustedError') aborted = aborted ?? ((err as { stop?: WriteAbortReason }).stop ?? 'budget_exhausted');
      else if (name === 'EffectBudgetExhaustedError') aborted = aborted ?? 'effect_budget_exhausted';
      return null;
    }
  };

  const reserveHolds = () => {
    const remaining = ctx.budget?.remaining() ?? Infinity;
    return remaining >= 2 * liveCreatedThisRun + 1;
  };

  const itemParams = (action: Action, idParam: string, ref: ValueRef): Record<string, unknown> | null => {
    const filled = fillParams(action, { exclude: idParam, deterministic: true, runId: opts.runId });
    return filled.ok ? { ...filled.params, [idParam]: ref } : null;
  };

  const blank = (family: ResourceFamily): FamilyObservation => ({
    entity: family.entity,
    createTool: family.create.name,
    createActionKey: family.create.id,
    skipped: null,
    steps: { create: null, read: null, update: null, readAfterUpdate: null, delete: null, readAfterDelete: null },
    idSource: null,
    convergence: 'not_attempted',
    pollCount: 0,
    schemaValid: null,
    unknownFieldCount: null,
    serverGeneratedFieldCount: null,
    updateReflected: null,
    useAfterFree: 'not_attempted',
    cleanup: 'not_created',
    requests: 0,
  });

  let executed = 0;
  for (const family of families) {
    const obs = blank(family);
    observations.push(obs);
    const before = requestsMade;
    const finish = () => {
      obs.requests = requestsMade - before;
    };

    if (aborted) {
      obs.skipped = 'aborted';
      continue;
    }
    if (family.skip) {
      obs.skipped = family.skip;
      continue;
    }
    if (executed >= maxFamilies) {
      obs.skipped = 'aborted';
      continue;
    }
    const contract = deriveCleanupContract(family, opts.contracts.get(family.create.name) ?? false);
    const decision = mayProbe(family.create, policy, contract);
    if (!decision.allowed) {
      obs.skipped = decision.reason as ProbeDenyReason;
      continue;
    }
    if ((live.get(family.entity) ?? 0) >= leakCap) {
      obs.skipped = 'leak_cap_reached';
      continue;
    }
    if (!reserveHolds()) {
      obs.skipped = 'cleanup_reserve_reached';
      aborted = 'cleanup_reserve_reached';
      continue;
    }
    const body = synthesizeCreateBody(family.create, opts.runId);
    if (!body.ok) {
      obs.skipped = body.reason;
      continue;
    }
    const bodyName = bodyParamName(family.create);
    const otherParams = fillParams(family.create, { exclude: bodyName ?? undefined, deterministic: true, runId: opts.runId });
    if (!otherParams.ok || !bodyName || !family.read || !family.remove || !family.idParam) {
      obs.skipped = 'params_unfillable';
      continue;
    }
    executed++;

    // --- create ------------------------------------------------------------
    const created = await call(ctx, family.create, { ...otherParams.params, [bodyName]: body.body }, { captureLocation: true });
    obs.steps.create = created?.status ?? null;
    if (!created || !isSuccess(created.status)) {
      finish();
      continue;
    }
    const createdBody = parseJson(created.bodyText);
    let ref: ValueRef | null = null;
    let idSource: IdSource = 'unavailable';
    for (const candidate of family.idFieldCandidates) {
      const extracted = createdBody === undefined ? null : selectValues(createdBody, candidate, 1);
      if (extracted?.refs[0]) {
        ref = extracted.refs[0];
        idSource = 'body';
        break;
      }
    }
    if (!ref && created.locationRef) {
      ref = created.locationRef;
      idSource = 'location';
    }
    obs.idSource = idSource;
    const resource: CreatedResource = {
      entity: family.entity,
      createActionKey: family.create.id,
      deleteActionKey: family.remove.id,
      ref,
      idSource,
      cleanup: ref ? 'deleted_unconfirmed' : 'quarantined',
      deleteStatus: null,
      readbackStatus: null,
    };
    resources.push(resource);
    live.set(family.entity, (live.get(family.entity) ?? 0) + 1);
    liveCreatedThisRun++;
    if (!ref) {
      // Nothing can address this object again. Stop the family; the run will
      // end *_with_quarantined_resources and a person has to look.
      obs.cleanup = 'quarantined';
      finish();
      continue;
    }

    // --- read back: ensure_resource_availability ------------------------------
    const readParams = itemParams(family.read, family.idParam, ref);
    let readBody: unknown;
    if (readParams && !aborted) {
      let res = await call(ctx, family.read, readParams);
      obs.steps.read = res?.status ?? null;
      let polls = 0;
      while (res && !isSuccess(res.status) && res.status !== 429 && polls < POLL_DELAYS_MS.length && !aborted && reserveHolds()) {
        await sleep(POLL_DELAYS_MS[polls]);
        polls++;
        res = await call(ctx, family.read, readParams);
        obs.steps.read = res?.status ?? obs.steps.read;
      }
      obs.pollCount = polls;
      if (res && isSuccess(res.status)) {
        obs.convergence = polls ? 'after_poll' : 'immediate';
        readBody = parseJson(res.bodyText);
        if (readBody !== undefined) {
          const schemaValid = family.read.responseSchema ? validateResponse(family.read.responseSchema, readBody).valid : null;
          obs.schemaValid = schemaValid;
          const documented = documentedPaths(family.read);
          if (documented) {
            const observedPaths = Object.keys(inferShape(readBody)).filter((p) => p !== 'response');
            obs.unknownFieldCount = observedPaths.filter((p) => !documented.has(p)).length;
          }
          const sent = topLevelKeys(body.body);
          obs.serverGeneratedFieldCount = [...topLevelKeys(readBody)].filter((k) => !sent.has(k)).length;
        }
      } else if (res) {
        obs.convergence = 'never';
      }
    }

    // --- update ---------------------------------------------------------------
    if (family.update && !aborted && reserveHolds()) {
      const updateDecision = mayProbe(family.update, policy, contract);
      const change = synthesizeUpdateBody(family.update, body.body, opts.runId);
      const updateBodyName = bodyParamName(family.update);
      const updateParams = updateBodyName ? itemParams(family.update, family.idParam, ref) : null;
      if (updateDecision.allowed && change.ok && updateParams && updateBodyName) {
        const res = await call(ctx, family.update, { ...updateParams, [updateBodyName]: change.body });
        obs.steps.update = res?.status ?? null;
        if (res && isSuccess(res.status) && readParams && !aborted) {
          const after = await call(ctx, family.read, readParams);
          obs.steps.readAfterUpdate = after?.status ?? null;
          if (after && isSuccess(after.status)) {
            // Compared in memory; the body is dropped.
            obs.updateReflected = after.bodyText.includes(change.marker);
          }
        }
      }
    }

    // --- delete, and the use-after-free check ------------------------------------
    if (!aborted) {
      const deleteDecision = mayProbe(family.remove, policy, contract);
      const deleteParams = itemParams(family.remove, family.idParam, ref);
      if (deleteDecision.allowed && deleteParams) {
        const res = await call(ctx, family.remove, deleteParams);
        obs.steps.delete = res?.status ?? null;
        resource.deleteStatus = res?.status ?? null;
        if (res && (isSuccess(res.status) || res.status === 404) && readParams && !aborted) {
          const after = await call(ctx, family.read, readParams);
          obs.steps.readAfterDelete = after?.status ?? null;
          resource.readbackStatus = after?.status ?? null;
          if (after) {
            if (after.status === 404) obs.useAfterFree = 'gone_404';
            else if (after.status === 410) obs.useAfterFree = 'gone_410';
            else if (isSuccess(after.status)) obs.useAfterFree = softDeleted(parseJson(after.bodyText)) ? 'soft_deleted' : 'still_readable';
            const gone = obs.useAfterFree === 'gone_404' || obs.useAfterFree === 'gone_410' || obs.useAfterFree === 'soft_deleted';
            resource.cleanup = gone ? 'deleted_confirmed' : 'deleted_unconfirmed';
          }
        } else if (res && !isSuccess(res.status) && res.status !== 404) {
          resource.cleanup = 'delete_failed';
        }
      }
    }
    if (resource.cleanup === 'deleted_confirmed') {
      live.set(family.entity, Math.max(0, (live.get(family.entity) ?? 1) - 1));
      liveCreatedThisRun = Math.max(0, liveCreatedThisRun - 1);
      if (obs.steps.create !== null && obs.steps.delete !== null && !(opts.contracts.get(family.create.name) ?? false)) {
        rehearsed.push(family.create.name);
      }
    }
    obs.cleanup = resource.cleanup;
    finish();
  }

  // --- garbage collection ------------------------------------------------------
  // Everything created and not confirmed gone gets one more DELETE and read-back,
  // through the invoke WITHOUT the effect budget: a spent budget must never
  // strand a fixture. A run that was rate-limited still tries; the provider
  // may answer the cleanup even if it refused the experiment.
  for (const resource of resources) {
    if (resource.cleanup === 'deleted_confirmed' || resource.cleanup === 'quarantined' || !resource.ref || !resource.deleteActionKey) continue;
    const family = families.find((f) => f.remove?.id === resource.deleteActionKey);
    if (!family?.remove || !family.read || !family.idParam) continue;
    const deleteParams = itemParams(family.remove, family.idParam, resource.ref);
    const readParams = itemParams(family.read, family.idParam, resource.ref);
    if (!deleteParams || !readParams) continue;
    const del = await call(gcCtx, family.remove, deleteParams);
    resource.deleteStatus = del?.status ?? resource.deleteStatus;
    if (!del || !(isSuccess(del.status) || del.status === 404)) {
      resource.cleanup = 'delete_failed';
      continue;
    }
    const after = await call(gcCtx, family.read, readParams);
    resource.readbackStatus = after?.status ?? resource.readbackStatus;
    if (after && (after.status === 404 || after.status === 410 || (isSuccess(after.status) && softDeleted(parseJson(after.bodyText))))) {
      resource.cleanup = 'deleted_confirmed';
      const obs = observations.find((o) => o.createActionKey === resource.createActionKey && o.cleanup !== 'deleted_confirmed');
      if (obs) obs.cleanup = 'deleted_confirmed';
    } else {
      resource.cleanup = 'deleted_unconfirmed';
    }
  }

  for (const obs of observations) {
    if (obs.skipped) continue;
    evidence.push({
      kind: 'probe.write_lifecycle',
      source: 'probe',
      actionId: obs.createActionKey,
      payload: {
        actionId: obs.createActionKey,
        entity: obs.entity.slice(0, 64),
        runId: opts.runId,
        steps: obs.steps,
        idSource: obs.idSource,
        convergence: obs.convergence,
        pollCount: obs.pollCount,
        schemaValid: obs.schemaValid,
        unknownFieldCount: obs.unknownFieldCount,
        serverGeneratedFieldCount: obs.serverGeneratedFieldCount,
        updateReflected: obs.updateReflected,
        useAfterFree: obs.useAfterFree,
        cleanup: obs.cleanup,
      },
    });
  }

  const created = resources.length;
  const deletedConfirmed = resources.filter((r) => r.cleanup === 'deleted_confirmed').length;
  const quarantined = resources.filter((r) => r.cleanup !== 'deleted_confirmed').length;

  return {
    families: observations,
    resources,
    evidence,
    requestsMade,
    effectsUsed: opts.effects.used(),
    created,
    deletedConfirmed,
    quarantined,
    aborted,
    outcome: aborted ? 'canceled' : 'completed',
    contractsRehearsed: rehearsed,
  };
}
