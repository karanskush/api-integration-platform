// The write lifecycle against a stub API: create → read → update → delete →
// confirm gone, and every rule the runner header promises.
import { describe, expect, it } from 'vitest';
import { parseEvidencePayload } from '../../evidence';
import type { Action, ImportRecord } from '../../ir';
import type { InvokeResult, invokeAction } from '../../mcpTools';
import { isValueRef, makeRef } from '../../transient';
import { createBudget, createEffectBudget, withEffectBudget } from '../budget';
import { planResourceFamilies } from '../families';
import type { ProbeContext } from '../types';
import { policyFromConsent } from '../writePolicy';
import { runWriteLifecycle, type WriteRunOptions } from '../writeRunner';

const SENTINEL = 'tag_SENTINEL_7c1d';
const body = { type: 'object', 'x-docentapi-in': 'body', required: ['name'], properties: { name: { type: 'string' }, color: { type: 'string' } } };
const pathId = { type: 'object', required: ['tagId'], properties: { tagId: { type: 'string', 'x-docentapi-in': 'path' } } };

function action(o: Partial<Action> & { name: string; method: string; path: string }): Action {
  return {
    id: `id_${o.name}`,
    description: '',
    paramsSchema: { type: 'object', properties: {} },
    auth: 'bearer',
    safety: o.method === 'GET' ? 'read' : 'write',
    examples: [],
    ...o,
  } as Action;
}

const tagSchema = { type: 'object', required: ['id', 'name'], properties: { id: { type: 'string' }, name: { type: 'string' }, color: { type: 'string' } } };

function tagsRecord(prefix = 'tag', collection = '/tags'): ImportRecord {
  const actions = [
    action({ name: `create_${prefix}`, method: 'POST', path: collection, paramsSchema: { type: 'object', required: ['body'], properties: { body } } }),
    action({ name: `get_${prefix}`, method: 'GET', path: `${collection}/{tagId}`, paramsSchema: pathId, responseSchema: tagSchema }),
    action({ name: `update_${prefix}`, method: 'PATCH', path: `${collection}/{tagId}`, paramsSchema: { type: 'object', required: ['tagId'], properties: { ...pathId.properties, body } } }),
    action({ name: `delete_${prefix}`, method: 'DELETE', path: `${collection}/{tagId}`, paramsSchema: pathId }),
  ];
  return { id: 'r', name: 'R', source: 'openapi', baseUrls: ['https://api.example.test'], auth: 'bearer', actions, counts: { total: 4, read: 1, write: 3, destructive: 0 }, createdAt: 0, expiresAt: 0 };
}

type Call = { method: string; path: string; params: Record<string, unknown>; key?: string };

type StubOptions = {
  createStatus?: number;
  idInBody?: boolean;
  location?: boolean;
  readsBeforeFound?: number;
  deleteStatus?: number;
  readableAfterDelete?: boolean;
  softDeleteAfterDelete?: boolean;
  extraFields?: Record<string, unknown>;
  updateStatus?: number;
  rateLimitOn?: 'create' | 'update' | null;
};

/** An in-memory tags API. Returns the invoke and the calls it saw. */
function stubApi(opts: StubOptions = {}) {
  const calls: Call[] = [];
  const store = new Map<string, Record<string, unknown>>();
  let reads = 0;
  const res = (status: number, bodyObj?: unknown, extra: Partial<InvokeResult> = {}): InvokeResult => ({ status, latencyMs: 1, bodyText: bodyObj === undefined ? '' : JSON.stringify(bodyObj), ...extra });
  const invoke = (async (action: Action, params: Record<string, unknown>, _t, key) => {
    calls.push({ method: action.method, path: action.path, params, key });
    const method = action.method.toUpperCase();
    if (method === 'POST') {
      if (opts.rateLimitOn === 'create') return res(429, { error: 'slow down' });
      if (opts.createStatus && opts.createStatus >= 400) return res(opts.createStatus, { error: 'nope' });
      const sent = params.body as Record<string, unknown>;
      store.set(SENTINEL, { id: SENTINEL, ...sent, createdAt: '2026-01-01', ...(opts.extraFields ?? {}) });
      const out: Record<string, unknown> = { ...store.get(SENTINEL)! };
      if (opts.idInBody === false) delete out.id;
      const locationRef = opts.location ? makeRef(SENTINEL) ?? undefined : undefined;
      return res(opts.createStatus ?? 201, out, locationRef ? { locationRef } : {});
    }
    const id = String(params.tagId);
    if (method === 'GET') {
      reads++;
      if (opts.readsBeforeFound && reads <= opts.readsBeforeFound) return res(404, { error: 'not yet' });
      const obj = store.get(id);
      if (obj) return res(200, obj);
      if (opts.readableAfterDelete && id === SENTINEL) return res(200, { id, name: 'ghost' });
      if (opts.softDeleteAfterDelete && id === SENTINEL) return res(200, { id, name: 'x', status: 'deleted' });
      return res(404, { error: 'not found' });
    }
    if (method === 'PATCH') {
      if (opts.rateLimitOn === 'update') return res(429, { error: 'slow down' });
      const obj = store.get(id);
      if (!obj) return res(404);
      store.set(id, { ...obj, ...(params.body as object) });
      return res(opts.updateStatus ?? 200, store.get(id));
    }
    if (method === 'DELETE') {
      if (opts.deleteStatus && opts.deleteStatus >= 400) return res(opts.deleteStatus, { error: 'cannot' });
      store.delete(id);
      return res(opts.deleteStatus ?? 204);
    }
    return res(405);
  }) as typeof invokeAction;
  return { invoke, calls, store };
}

const consent = { environment: 'sandbox' as const, consentedAt: new Date('2026-09-14') };

function run(record: ImportRecord, invoke: typeof invokeAction, over: Partial<WriteRunOptions> & { ctx?: Partial<ProbeContext>; approve?: (names: Set<string>) => void } = {}) {
  const families = planResourceFamilies(record);
  const policy = policyFromConsent(families, consent, 6);
  over.approve?.(policy.approvedOperations as Set<string>);
  const ctx: ProbeContext = { record, upstreamKey: 'sk_test_fixture', invoke, environment: 'sandbox', runId: 'run1', ...over.ctx };
  const { ctx: _c, approve: _a, ...rest } = over;
  return runWriteLifecycle(ctx, families, policy, { runId: 'run1', contracts: new Map(), effects: createEffectBudget(6), sleep: async () => {}, ...rest });
}

describe('the happy path', () => {
  it('creates, reads, updates, deletes and confirms the object gone', async () => {
    const api = stubApi();
    const result = await run(tagsRecord(), api.invoke);
    const [fam] = result.families;
    expect(fam.skipped).toBeNull();
    expect(fam.steps).toEqual({ create: 201, read: 200, update: 200, readAfterUpdate: 200, delete: 204, readAfterDelete: 404 });
    expect(fam.idSource).toBe('body');
    expect(fam.convergence).toBe('immediate');
    expect(fam.updateReflected).toBe(true);
    expect(fam.useAfterFree).toBe('gone_404');
    expect(fam.cleanup).toBe('deleted_confirmed');
    expect(result.outcome).toBe('completed');
    expect(result.quarantined).toBe(0);
    expect(result.deletedConfirmed).toBe(1);
    expect(result.contractsRehearsed).toEqual(['create_tag']);
    expect(api.store.size).toBe(0);
  });

  it('sends the created id back to the API but never lets it into the result', async () => {
    const api = stubApi();
    const result = await run(tagsRecord(), api.invoke);
    const del = api.calls.find((c) => c.method === 'DELETE');
    expect(del?.params.tagId).toBe(SENTINEL);
    expect(JSON.stringify(result)).not.toContain('SENTINEL');
    expect(isValueRef(result.resources[0].ref)).toBe(true);
  });

  it('judges the read-back against the documented schema and counts what the server added', async () => {
    const api = stubApi({ extraFields: { workspaceId: 'ws_1' } });
    const result = await run(tagsRecord(), api.invoke);
    const [fam] = result.families;
    expect(fam.schemaValid).toBe(true);
    // createdAt and workspaceId are not in the schema.
    expect(fam.unknownFieldCount).toBe(2);
    // id, createdAt, workspaceId were not in the body we sent.
    expect(fam.serverGeneratedFieldCount).toBe(3);
  });

  it('emits one write_lifecycle fact per executed family, parseable at the read boundary', async () => {
    const api = stubApi();
    const result = await run(tagsRecord(), api.invoke);
    const facts = result.evidence.filter((e) => e.kind === 'probe.write_lifecycle');
    expect(facts).toHaveLength(1);
    const parsed = parseEvidencePayload('probe.write_lifecycle', facts[0].payload);
    expect(parsed).toMatchObject({ actionId: 'id_create_tag', entity: 'tag', useAfterFree: 'gone_404', cleanup: 'deleted_confirmed', runId: 'run1' });
  });

  it('tags every string it invents with the run id', async () => {
    const api = stubApi();
    await run(tagsRecord(), api.invoke);
    const create = api.calls.find((c) => c.method === 'POST');
    expect((create?.params.body as { name: string }).name).toBe('docentapi-probe-run1');
  });

  it('finds an object that appears after a wait', async () => {
    const api = stubApi({ readsBeforeFound: 1 });
    const result = await run(tagsRecord(), api.invoke);
    expect(result.families[0].convergence).toBe('after_poll');
    expect(result.families[0].pollCount).toBe(1);
  });

  it('takes the id from Location when the body has none', async () => {
    const api = stubApi({ idInBody: false, location: true });
    const result = await run(tagsRecord(), api.invoke);
    expect(result.families[0].idSource).toBe('location');
    expect(result.families[0].cleanup).toBe('deleted_confirmed');
  });
});

describe('the policy gate runs before every mutating request', () => {
  it('a family without consent makes zero calls', async () => {
    const api = stubApi();
    const record = tagsRecord();
    const families = planResourceFamilies(record);
    const policy = policyFromConsent(families, null, 6);
    const result = await runWriteLifecycle({ record, invoke: api.invoke, environment: 'sandbox' }, families, policy, { runId: 'r', contracts: new Map(), effects: createEffectBudget(6) });
    expect(api.calls).toHaveLength(0);
    expect(result.families[0].skipped).toBe('above_policy_max');
    expect(result.created).toBe(0);
  });

  it('an unapproved update is not sent, and the rest of the lifecycle still runs', async () => {
    const api = stubApi();
    const result = await run(tagsRecord(), api.invoke, { approve: (names) => names.delete('update_tag') });
    expect(api.calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(result.families[0].steps.update).toBeNull();
    expect(result.families[0].cleanup).toBe('deleted_confirmed');
  });

  it('a second create is not sent once the cap of live objects per entity is reached', async () => {
    const api = stubApi();
    const result = await run(tagsRecord(), api.invoke, { liveObjectsByEntity: new Map([['tag', 3]]) });
    expect(result.families[0].skipped).toBe('leak_cap_reached');
    expect(api.calls).toHaveLength(0);
  });

  it('does not create when the request budget could not also clean up', async () => {
    const api = stubApi();
    const result = await run(tagsRecord(), api.invoke, { ctx: { budget: createBudget({ maxRequests: 0, deadlineMs: 60_000 }) } });
    expect(result.families[0].skipped).toBe('cleanup_reserve_reached');
    expect(result.aborted).toBe('cleanup_reserve_reached');
    expect(api.calls).toHaveLength(0);
  });
});

describe('cleanup is correctness', () => {
  it('an object it cannot identify is quarantined at once and its family stops', async () => {
    const api = stubApi({ idInBody: false });
    const result = await run(tagsRecord(), api.invoke);
    expect(result.families[0].idSource).toBe('unavailable');
    expect(result.families[0].cleanup).toBe('quarantined');
    expect(api.calls.map((c) => c.method)).toEqual(['POST']);
    expect(result.quarantined).toBe(1);
    expect(result.outcome).toBe('completed');
    expect(result.contractsRehearsed).toEqual([]);
  });

  it('an object still readable after DELETE is unresolved, retried by the collector, and counted', async () => {
    const api = stubApi({ readableAfterDelete: true });
    const result = await run(tagsRecord(), api.invoke);
    expect(result.families[0].useAfterFree).toBe('still_readable');
    // Lifecycle delete + GC delete.
    expect(api.calls.filter((c) => c.method === 'DELETE')).toHaveLength(2);
    expect(result.resources[0].cleanup).toBe('deleted_unconfirmed');
    expect(result.quarantined).toBe(1);
    expect(result.contractsRehearsed).toEqual([]);
  });

  it('a soft-delete flag counts as gone', async () => {
    const api = stubApi({ softDeleteAfterDelete: true });
    const result = await run(tagsRecord(), api.invoke);
    expect(result.families[0].useAfterFree).toBe('soft_deleted');
    expect(result.resources[0].cleanup).toBe('deleted_confirmed');
  });

  it('a refused DELETE is delete_failed after the collector has tried again', async () => {
    const api = stubApi({ deleteStatus: 500 });
    const result = await run(tagsRecord(), api.invoke);
    expect(result.resources[0].cleanup).toBe('delete_failed');
    expect(api.calls.filter((c) => c.method === 'DELETE')).toHaveLength(2);
    expect(result.quarantined).toBe(1);
  });

  it('a spent effect budget aborts the experiment but never the cleanup', async () => {
    const api = stubApi();
    const effects = createEffectBudget(1);
    const result = await run(tagsRecord(), withEffectBudget(api.invoke, effects), { effects, cleanupInvoke: api.invoke });
    expect(result.aborted).toBe('effect_budget_exhausted');
    expect(result.families[0].steps.update).toBeNull();
    expect(result.resources[0].cleanup).toBe('deleted_confirmed');
    expect(result.outcome).toBe('canceled');
    expect(result.quarantined).toBe(0);
    expect(api.store.size).toBe(0);
  });
});

describe('rate limits', () => {
  it('a 429 on create aborts the run and skips the remaining families', async () => {
    const api = stubApi({ rateLimitOn: 'create' });
    const record = tagsRecord();
    const other = tagsRecord('label', '/labels');
    const both: ImportRecord = { ...record, actions: [...record.actions, ...other.actions] };
    const result = await run(both, api.invoke);
    expect(result.aborted).toBe('rate_limited');
    expect(result.outcome).toBe('canceled');
    expect(result.families[1].skipped).toBe('aborted');
    expect(api.calls).toHaveLength(1);
  });

  it('a 429 after create still garbage-collects the object', async () => {
    const api = stubApi({ rateLimitOn: 'update' });
    const result = await run(tagsRecord(), api.invoke);
    expect(result.aborted).toBe('rate_limited');
    expect(api.calls.some((c) => c.method === 'DELETE')).toBe(true);
    expect(result.resources[0].cleanup).toBe('deleted_confirmed');
    expect(result.quarantined).toBe(0);
  });
});

describe('bounds', () => {
  it('runs at most maxFamilies families', async () => {
    const api = stubApi();
    const record = tagsRecord();
    const other = tagsRecord('label', '/labels');
    const both: ImportRecord = { ...record, actions: [...record.actions, ...other.actions] };
    const result = await run(both, api.invoke, { maxFamilies: 1 });
    expect(result.families.filter((f) => !f.skipped)).toHaveLength(1);
  });

  it('a create that fails leaves nothing to clean up', async () => {
    const api = stubApi({ createStatus: 422 });
    const result = await run(tagsRecord(), api.invoke);
    expect(result.families[0].steps.create).toBe(422);
    expect(result.created).toBe(0);
    expect(api.calls).toHaveLength(1);
  });
});
