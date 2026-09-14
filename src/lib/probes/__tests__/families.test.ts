// Planning which resources a write probe may touch, from the spec alone.
import { describe, expect, it } from 'vitest';
import type { Action, ImportRecord } from '../../ir';
import { planResourceFamilies } from '../families';
import { denylistPattern } from '../policy';

const body = { type: 'object', 'x-docentapi-in': 'body', required: ['name'], properties: { name: { type: 'string' } } };
const pathId = (name: string) => ({ type: 'object', required: [name], properties: { [name]: { type: 'string', 'x-docentapi-in': 'path' } } });

function action(o: Partial<Action> & { name: string; method: string; path: string }): Action {
  return {
    id: `id_${o.name}`,
    description: '',
    paramsSchema: { type: 'object', properties: {} },
    auth: 'bearer',
    safety: o.method === 'GET' ? 'read' : o.method === 'DELETE' ? 'destructive' : 'write',
    examples: [],
    ...o,
  } as Action;
}

function record(actions: Action[]): ImportRecord {
  return {
    id: 'r',
    name: 'R',
    source: 'openapi',
    baseUrls: ['https://api.example.test'],
    auth: 'bearer',
    actions,
    counts: { total: actions.length, read: 0, write: 0, destructive: 0 },
    createdAt: 0,
    expiresAt: 0,
  };
}

const tags = [
  action({ name: 'create_tag', method: 'POST', path: '/tags', paramsSchema: { type: 'object', required: ['body'], properties: { body } } }),
  action({ name: 'get_tag', method: 'GET', path: '/tags/{tagId}', paramsSchema: pathId('tagId') }),
  action({ name: 'update_tag', method: 'PATCH', path: '/tags/{tagId}', paramsSchema: { ...pathId('tagId'), properties: { ...pathId('tagId').properties, body } } }),
  action({ name: 'delete_tag', method: 'DELETE', path: '/tags/{tagId}', paramsSchema: pathId('tagId') }),
];

describe('a complete family', () => {
  it('pairs the collection POST with the item GET, PATCH and DELETE', () => {
    const [f] = planResourceFamilies(record(tags));
    expect(f.skip).toBeNull();
    expect(f.entity).toBe('tag');
    expect(f.idParam).toBe('tagId');
    expect(f.create.name).toBe('create_tag');
    expect(f.read?.name).toBe('get_tag');
    expect(f.update?.name).toBe('update_tag');
    expect(f.remove?.name).toBe('delete_tag');
  });

  it('lists the conventional id spellings, most likely first', () => {
    const [f] = planResourceFamilies(record(tags));
    expect(f.idFieldCandidates[0]).toBe('response.id');
    expect(f.idFieldCandidates).toContain('response.tagId');
    expect(f.idFieldCandidates).toContain('response.data.id');
  });

  it('classifies a plain create as R3 — a mutation without a tested contract', () => {
    const [f] = planResourceFamilies(record(tags));
    expect(f.risk).toBe('R3');
  });
});

describe('what the planner declines, and why', () => {
  it('no DELETE → no_delete (the inverse operation is the contract)', () => {
    const [f] = planResourceFamilies(record(tags.filter((a) => a.method !== 'DELETE')));
    expect(f.skip).toBe('no_delete');
  });

  it('no item GET → no_read (nothing could confirm the object exists or is gone)', () => {
    const [f] = planResourceFamilies(record(tags.filter((a) => a.method !== 'GET')));
    expect(f.skip).toBe('no_read');
  });

  it('no item path at all → no_item_path', () => {
    const [f] = planResourceFamilies(record([tags[0]]));
    expect(f.skip).toBe('no_item_path');
  });

  it('a POST without a body → no_body', () => {
    const noBody = { ...tags[0], paramsSchema: { type: 'object', properties: {} } } as Action;
    const [f] = planResourceFamilies(record([noBody, ...tags.slice(1)]));
    expect(f.skip).toBe('no_body');
  });

  it('a consequential resource is never a family: payments → r4_never_probed', () => {
    const payments = tags.map((a) => ({ ...a, name: a.name.replace('tag', 'payment'), path: a.path.replace('tags', 'payments') }) as Action);
    const [f] = planResourceFamilies(record(payments));
    expect(f.skip).toBe('r4_never_probed');
  });

  it("the provider's own never-touch word outranks ours", () => {
    const [f] = planResourceFamilies(record(tags), { denylist: denylistPattern(['tags']) });
    expect(f.skip).toBe('r4_never_probed');
  });

  it('a POST on an item path is not a create', () => {
    const act = action({ name: 'archive_tag', method: 'POST', path: '/tags/{tagId}/archive', paramsSchema: pathId('tagId') });
    expect(planResourceFamilies(record([act]))).toHaveLength(0);
  });
});

describe('ordering', () => {
  it('puts runnable families before skipped ones', () => {
    const noDelete = tags.filter((a) => a.method !== 'DELETE').map((a) => ({ ...a, name: `${a.name}_x`, path: a.path.replace('tags', 'xs') }) as Action);
    const fams = planResourceFamilies(record([...noDelete, ...tags]));
    expect(fams[0].skip).toBeNull();
    expect(fams[1].skip).toBe('no_delete');
  });
});
