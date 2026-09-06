import { describe, expect, it } from 'vitest';
import type { Action, ImportRecord, JSONSchema } from '../../ir';
import { diffRecords, highestSeverity, MAX_CHANGES, type Change } from '../diff';

const NOW = new Date('2026-09-06T12:00:00.000Z');

function action(overrides: Partial<Action> = {}): Action {
  return {
    id: 'a1',
    name: 'get_thing',
    description: 'Get a thing',
    method: 'GET',
    path: '/things/{id}',
    paramsSchema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string', 'x-docentapi-in': 'path' } },
    },
    auth: 'bearer',
    safety: 'read',
    examples: [],
    responseSchema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } },
    ...overrides,
  };
}

function record(overrides: Partial<ImportRecord> = {}): ImportRecord {
  const actions = overrides.actions ?? [action()];
  return {
    id: 'r',
    name: 'Diff API',
    source: 'openapi',
    baseUrls: ['https://api.example.com'],
    auth: 'bearer',
    actions,
    counts: { total: actions.length, read: actions.length, write: 0, destructive: 0 },
    createdAt: 0,
    expiresAt: 0,
    ...overrides,
  };
}

function diff(prev: Partial<ImportRecord>, next: Partial<ImportRecord>) {
  return diffRecords(record(prev), record(next), { now: NOW });
}

function only(changes: Change[], kind: Change['kind']): Change[] {
  return changes.filter((c) => c.kind === kind);
}

function withBody(body: JSONSchema, required = true): Action {
  return action({
    id: 'w1',
    name: 'create_thing',
    method: 'POST',
    path: '/things',
    safety: 'write',
    paramsSchema: {
      type: 'object',
      ...(required ? { required: ['body'] } : {}),
      properties: { body: { ...body, 'x-docentapi-in': 'body' } },
    },
  });
}

describe('diffRecords — no change', () => {
  it('reports nothing for identical records', () => {
    const set = diff({}, {});
    expect(set.changes).toEqual([]);
    expect(set.highest).toBeNull();
    expect(set.counts).toEqual({ breaking: 0, risky: 0, additive: 0, cosmetic: 0 });
    expect(set.toolsChanged).toEqual([]);
    expect(set.truncated).toBe(false);
  });

  it('treats an absent deprecated flag and false as the same state', () => {
    const set = diff({ actions: [action()] }, { actions: [action({ deprecated: false })] });
    expect(set.changes).toEqual([]);
  });

  it('is deterministic', () => {
    const a = diff({ actions: [action(), action({ id: 'b', name: 'other', path: '/o' })] }, { actions: [action({ description: 'x' })] });
    const b = diff({ actions: [action(), action({ id: 'b', name: 'other', path: '/o' })] }, { actions: [action({ description: 'x' })] });
    expect(a).toEqual(b);
  });
});

describe('diffRecords — operations', () => {
  it('an added operation is additive and shows up in toolsChanged', () => {
    const set = diff({}, { actions: [action(), action({ id: 'n1', name: 'list_things', path: '/things' })] });
    expect(only(set.changes, 'operation.added')).toHaveLength(1);
    expect(set.highest).toBe('additive');
    expect(set.toolsChanged).toEqual(['list_things']);
  });

  it('a removed operation without notice is breaking', () => {
    const set = diff({}, { actions: [] });
    const [removed] = only(set.changes, 'operation.removed');
    expect(removed.severity).toBe('breaking');
    expect(removed.summary).toContain('without a deprecation notice');
    expect(removed.tool).toBe('get_thing');
    expect(set.toolsChanged).toEqual(['get_thing']);
  });

  // oasdiff's deprecation workflow: an announced sunset that has passed makes
  // the removal expected rather than surprising.
  it('a removal after a past sunset is risky, before it is breaking', () => {
    const after = diff({ actions: [action({ deprecated: true, sunsetAt: '2026-01-01T00:00:00.000Z' })] }, { actions: [] });
    expect(only(after.changes, 'operation.removed')[0].severity).toBe('risky');

    const before = diff({ actions: [action({ deprecated: true, sunsetAt: '2027-01-01T00:00:00.000Z' })] }, { actions: [] });
    expect(only(before.changes, 'operation.removed')[0].severity).toBe('breaking');
    expect(only(before.changes, 'operation.removed')[0].summary).toContain('before its announced sunset');
  });

  it('marking deprecated and scheduling a sunset are risky; withdrawing them is cosmetic', () => {
    const on = diff({}, { actions: [action({ deprecated: true, sunsetAt: '2027-06-30T00:00:00.000Z' })] });
    expect(only(on.changes, 'operation.deprecated')[0].severity).toBe('risky');
    expect(only(on.changes, 'operation.sunset_scheduled')[0].severity).toBe('risky');

    const off = diff({ actions: [action({ deprecated: true, sunsetAt: '2027-06-30T00:00:00.000Z' })] }, {});
    expect(only(off.changes, 'operation.deprecated')[0].severity).toBe('cosmetic');
    expect(only(off.changes, 'operation.sunset_scheduled')[0].severity).toBe('cosmetic');
  });

  it('a renamed tool is breaking even though method and path are unchanged', () => {
    const set = diff({}, { actions: [action({ name: 'fetch_thing' })] });
    const [renamed] = only(set.changes, 'operation.renamed');
    expect(renamed.severity).toBe('breaking');
    expect(renamed).toMatchObject({ before: 'get_thing', after: 'fetch_thing' });
    expect(set.toolsChanged).toEqual(['fetch_thing', 'get_thing']);
  });

  it('auth none→scheme and scheme→scheme are breaking; scheme→none is risky', () => {
    expect(only(diff({ actions: [action({ auth: 'none' })] }, {}).changes, 'operation.auth_changed')[0].severity).toBe('breaking');
    expect(only(diff({}, { actions: [action({ auth: 'apiKey', authIn: { in: 'header', name: 'X-Key' } })] }).changes, 'operation.auth_changed')[0].severity).toBe('breaking');
    expect(only(diff({}, { actions: [action({ auth: 'none' })] }).changes, 'operation.auth_changed')[0].severity).toBe('risky');
  });

  it('becoming destructive is breaking (it leaves tools/list); ceasing to be is additive; read↔write is risky', () => {
    expect(only(diff({}, { actions: [action({ safety: 'destructive' })] }).changes, 'operation.safety_changed')[0].severity).toBe('breaking');
    expect(only(diff({ actions: [action({ safety: 'destructive' })] }, {}).changes, 'operation.safety_changed')[0].severity).toBe('additive');
    expect(only(diff({}, { actions: [action({ safety: 'write' })] }).changes, 'operation.safety_changed')[0].severity).toBe('risky');
  });

  it('a newly required scope is breaking; a dropped one is additive', () => {
    const added = diff({ actions: [action({ auth: 'oauth2', scopes: ['read'] })] }, { actions: [action({ auth: 'oauth2', scopes: ['read', 'write'] })] });
    expect(only(added.changes, 'operation.scopes_changed')[0].severity).toBe('breaking');
    const dropped = diff({ actions: [action({ auth: 'oauth2', scopes: ['read', 'write'] })] }, { actions: [action({ auth: 'oauth2', scopes: ['read'] })] });
    expect(only(dropped.changes, 'operation.scopes_changed')[0].severity).toBe('additive');
  });

  it('a description change is cosmetic and does not touch toolsChanged for a destructive (unexposed) op', () => {
    const set = diff({}, { actions: [action({ description: 'Fetches a thing' })] });
    expect(only(set.changes, 'operation.description_changed')[0].severity).toBe('cosmetic');
    // Descriptions are part of the tool descriptor, so an exposed tool's
    // fingerprint moves...
    expect(set.toolsChanged).toEqual(['get_thing']);
    // ...but a destructive operation is not in tools/list at all.
    const hidden = diff(
      { actions: [action({ safety: 'destructive' })] },
      { actions: [action({ safety: 'destructive', description: 'Fetches a thing' })] },
    );
    expect(hidden.toolsChanged).toEqual([]);
  });
});

describe('diffRecords — request fields', () => {
  const base = withBody({
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string' },
      kind: { type: 'string', enum: ['a', 'b'] },
      count: { type: 'integer', format: 'int32' },
      note: { type: ['string', 'null'] },
    },
  });

  it('removing a request field is breaking; adding an optional one is additive; adding a required one is breaking', () => {
    const removed = diff({ actions: [base] }, { actions: [withBody({ type: 'object', required: ['name'], properties: { name: { type: 'string' } } })] });
    expect(only(removed.changes, 'field.removed').map((c) => c.severity)).toEqual(['breaking', 'breaking', 'breaking']);

    const added = diff(
      { actions: [base] },
      {
        actions: [
          withBody({
            type: 'object',
            required: ['name', 'owner'],
            properties: { ...(base.paramsSchema.properties as Record<string, Record<string, unknown>>).body.properties as Record<string, unknown>, owner: { type: 'string' }, tag: { type: 'string' } },
          }),
        ],
      },
    );
    const adds = only(added.changes, 'field.added');
    expect(adds.find((c) => c.fieldPath === 'body.owner')?.severity).toBe('breaking');
    expect(adds.find((c) => c.fieldPath === 'body.tag')?.severity).toBe('additive');
  });

  it('flipping a request field to required is breaking; to optional is additive', () => {
    const props = (base.paramsSchema.properties as Record<string, Record<string, unknown>>).body.properties as Record<string, unknown>;
    const stricter = diff({ actions: [base] }, { actions: [withBody({ type: 'object', required: ['name', 'kind'], properties: props })] });
    expect(only(stricter.changes, 'field.required_changed')[0]).toMatchObject({ fieldPath: 'body.kind', severity: 'breaking' });
    const looser = diff({ actions: [base] }, { actions: [withBody({ type: 'object', required: [], properties: props })] });
    expect(only(looser.changes, 'field.required_changed')[0]).toMatchObject({ fieldPath: 'body.name', severity: 'additive' });
  });

  it('a type change is breaking; a format-only change is risky', () => {
    const props = structuredClone((base.paramsSchema.properties as Record<string, Record<string, unknown>>).body.properties as Record<string, Record<string, unknown>>);
    const typed = diff({ actions: [base] }, { actions: [withBody({ type: 'object', required: ['name'], properties: { ...props, count: { type: 'string' } } })] });
    expect(only(typed.changes, 'field.type_changed')[0]).toMatchObject({ fieldPath: 'body.count', severity: 'breaking' });
    const formatted = diff({ actions: [base] }, { actions: [withBody({ type: 'object', required: ['name'], properties: { ...props, count: { type: 'integer', format: 'int64' } } })] });
    expect(only(formatted.changes, 'field.type_changed')[0]).toMatchObject({ fieldPath: 'body.count', severity: 'risky' });
  });

  it('removing a request enum value is breaking; adding one is additive; introducing an enum is breaking', () => {
    const props = structuredClone((base.paramsSchema.properties as Record<string, Record<string, unknown>>).body.properties as Record<string, Record<string, unknown>>);
    const narrowed = diff({ actions: [base] }, { actions: [withBody({ type: 'object', required: ['name'], properties: { ...props, kind: { type: 'string', enum: ['a'] } } })] });
    expect(only(narrowed.changes, 'field.enum_changed')[0].severity).toBe('breaking');
    const widened = diff({ actions: [base] }, { actions: [withBody({ type: 'object', required: ['name'], properties: { ...props, kind: { type: 'string', enum: ['a', 'b', 'c'] } } })] });
    expect(only(widened.changes, 'field.enum_changed')[0].severity).toBe('additive');
    const introduced = diff({ actions: [base] }, { actions: [withBody({ type: 'object', required: ['name'], properties: { ...props, name: { type: 'string', enum: ['x'] } } })] });
    expect(only(introduced.changes, 'field.enum_changed')[0].severity).toBe('breaking');
  });

  it('making a request field non-nullable is breaking; nullable is additive', () => {
    const props = structuredClone((base.paramsSchema.properties as Record<string, Record<string, unknown>>).body.properties as Record<string, Record<string, unknown>>);
    const stricter = diff({ actions: [base] }, { actions: [withBody({ type: 'object', required: ['name'], properties: { ...props, note: { type: 'string' } } })] });
    expect(only(stricter.changes, 'field.nullable_changed')[0]).toMatchObject({ fieldPath: 'body.note', severity: 'breaking' });
    const looser = diff({ actions: [base] }, { actions: [withBody({ type: 'object', required: ['name'], properties: { ...props, name: { type: ['string', 'null'] } } })] });
    expect(only(looser.changes, 'field.nullable_changed')[0]).toMatchObject({ fieldPath: 'body.name', severity: 'additive' });
  });

  it('marking a request field readOnly is breaking; deprecated is risky', () => {
    const props = structuredClone((base.paramsSchema.properties as Record<string, Record<string, unknown>>).body.properties as Record<string, Record<string, unknown>>);
    const ro = diff({ actions: [base] }, { actions: [withBody({ type: 'object', required: ['name'], properties: { ...props, count: { type: 'integer', format: 'int32', readOnly: true } } })] });
    expect(ro.changes.find((c) => c.fieldPath === 'body.count')?.severity).toBe('breaking');
    const dep = diff({ actions: [base] }, { actions: [withBody({ type: 'object', required: ['name'], properties: { ...props, count: { type: 'integer', format: 'int32', deprecated: true } } })] });
    expect(only(dep.changes, 'field.deprecated')[0]).toMatchObject({ fieldPath: 'body.count', severity: 'risky' });
  });
});

describe('diffRecords — response fields', () => {
  it('removing a response property is breaking; adding one is additive', () => {
    const removed = diff({}, { actions: [action({ responseSchema: { type: 'object', properties: { id: { type: 'string' } } } })] });
    expect(only(removed.changes, 'field.removed')[0]).toMatchObject({ fieldPath: 'response.name', location: 'response', severity: 'breaking' });
    const added = diff({}, { actions: [action({ responseSchema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, extra: { type: 'boolean' } } } })] });
    expect(only(added.changes, 'field.added')[0]).toMatchObject({ fieldPath: 'response.extra', severity: 'additive' });
  });

  it('a response type change is breaking; a required→optional is risky; optional→required is additive', () => {
    const typed = diff({}, { actions: [action({ responseSchema: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } } } })] });
    expect(only(typed.changes, 'field.type_changed')[0]).toMatchObject({ fieldPath: 'response.id', severity: 'breaking' });

    const guaranteed = action({ responseSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, name: { type: 'string' } } } });
    const loosened = diff({ actions: [guaranteed] }, {});
    expect(only(loosened.changes, 'field.required_changed')[0]).toMatchObject({ fieldPath: 'response.id', severity: 'risky' });
    const tightened = diff({}, { actions: [guaranteed] });
    expect(only(tightened.changes, 'field.required_changed')[0]).toMatchObject({ fieldPath: 'response.id', severity: 'additive' });
  });

  it('a new response enum value is risky; a removed one is additive; nullable→ risky', () => {
    const prev = action({ responseSchema: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'closed'] } } } });
    const more = diff({ actions: [prev] }, { actions: [action({ responseSchema: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'closed', 'archived'] } } } })] });
    expect(only(more.changes, 'field.enum_changed')[0].severity).toBe('risky');
    const fewer = diff({ actions: [prev] }, { actions: [action({ responseSchema: { type: 'object', properties: { status: { type: 'string', enum: ['open'] } } } })] });
    expect(only(fewer.changes, 'field.enum_changed')[0].severity).toBe('additive');
    const nullable = diff({ actions: [prev] }, { actions: [action({ responseSchema: { type: 'object', properties: { status: { type: ['string', 'null'], enum: ['open', 'closed'] } } } })] });
    expect(only(nullable.changes, 'field.nullable_changed')[0].severity).toBe('risky');
  });
});

describe('diffRecords — API level', () => {
  it('a changed primary base URL is breaking; an extra one is additive; a dropped secondary is risky', () => {
    expect(only(diff({}, { baseUrls: ['https://api2.example.com'] }).changes, 'api.base_url_changed')[0].severity).toBe('breaking');
    expect(only(diff({}, { baseUrls: ['https://api.example.com', 'https://eu.example.com'] }).changes, 'api.base_url_changed')[0].severity).toBe('additive');
    expect(only(diff({ baseUrls: ['https://api.example.com', 'https://eu.example.com'] }, {}).changes, 'api.base_url_changed')[0].severity).toBe('risky');
  });

  it('a changed dominant auth is risky at API level', () => {
    expect(only(diff({}, { auth: 'apiKey', authIn: { in: 'header', name: 'X-Key' } }).changes, 'api.auth_changed')[0].severity).toBe('risky');
  });
});

describe('diffRecords — ordering and truncation', () => {
  it('orders by severity, then operation rows before field rows', () => {
    const set = diff(
      { actions: [action(), action({ id: 'gone', name: 'gone_op', path: '/gone' })] },
      { actions: [action({ description: 'changed', responseSchema: { type: 'object', properties: { id: { type: 'string' } } } })] },
    );
    const kinds = set.changes.map((c) => `${c.severity}:${c.kind}`);
    expect(kinds).toEqual([
      'breaking:operation.removed',
      'breaking:field.removed',
      'cosmetic:operation.description_changed',
    ]);
  });

  it('caps the list, keeps counts over everything, and drops the least severe rows first', () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) wide[`f${i}`] = { type: 'string' };
    const prev = action({ responseSchema: { type: 'object', properties: wide } });
    const next = action({
      description: 'changed',
      responseSchema: { type: 'object', properties: { ...wide, ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`g${i}`, { type: 'string' }])) } },
    });
    const set = diffRecords(record({ actions: [prev] }), record({ actions: [next] }), { now: NOW, maxChanges: 5 });
    expect(set.truncated).toBe(true);
    expect(set.changes).toHaveLength(5);
    expect(set.counts.additive).toBe(20);
    expect(set.counts.cosmetic).toBe(1);
    // The cosmetic description row is the least severe and is the one dropped.
    expect(set.changes.every((c) => c.severity === 'additive')).toBe(true);
    expect(MAX_CHANGES).toBe(500);
  });

  it('highestSeverity ranks breaking above the rest', () => {
    expect(highestSeverity([{ severity: 'cosmetic' }, { severity: 'breaking' }, { severity: 'risky' }])).toBe('breaking');
    expect(highestSeverity([])).toBeNull();
  });
});
