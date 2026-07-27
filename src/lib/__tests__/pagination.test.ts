import { describe, expect, it } from 'vitest';
import { paginationFor } from '../pagination';
import type { Action } from '../ir';

function action(o: Partial<Action> & { name: string; method: string; path: string }): Action {
  return {
    id: `id_${o.name}`,
    description: 'd',
    paramsSchema: { type: 'object', properties: {} },
    auth: 'bearer',
    safety: 'read',
    examples: [],
    ...o,
  } as Action;
}

function query(names: Record<string, string>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [name, type] of Object.entries(names)) properties[name] = { 'x-spotcheck-in': 'query', type };
  return { type: 'object', properties };
}

function listAction(params: Record<string, string>, responseProps: Record<string, unknown> = {}): Action {
  return action({
    name: 'list_things',
    method: 'GET',
    path: '/things',
    paramsSchema: query(params),
    ...(Object.keys(responseProps).length ? { responseSchema: { type: 'object', properties: responseProps } } : {}),
  });
}

describe('paginationFor — cursor', () => {
  it('detects a cursor parameter', () => {
    const info = paginationFor(listAction({ cursor: 'string', limit: 'integer' }));
    expect(info.model).toBe('cursor');
    expect(info.cursorParam).toBe('cursor');
    expect(info.sizeParam).toBe('limit');
  });

  it('recognises the common cursor spellings', () => {
    for (const name of ['after', 'page_token', 'starting_after', 'continuation_token', 'next_token']) {
      expect(paginationFor(listAction({ [name]: 'string' })).model).toBe('cursor');
    }
  });

  it('normalizes camelCase parameter names', () => {
    const info = paginationFor(listAction({ pageToken: 'string', pageSize: 'integer' }));
    expect(info.model).toBe('cursor');
    expect(info.cursorParam).toBe('pageToken');
    expect(info.sizeParam).toBe('pageSize');
  });

  it('is high confidence when the response documents the next cursor', () => {
    const info = paginationFor(listAction({ cursor: 'string' }, { next_cursor: { type: 'string' } }));
    expect(info.confidence).toBe('high');
    expect(info.nextField).toBe('response.next_cursor');
    expect(info.note).toContain('next_cursor');
  });

  it('drops to medium and says so when no next field is documented', () => {
    const info = paginationFor(listAction({ cursor: 'string' }));
    expect(info.confidence).toBe('medium');
    expect(info.note).toContain('no next-cursor response field');
  });

  // Both offered: the cursor is the one that stays correct while rows change.
  it('prefers a cursor over a page number when an API offers both', () => {
    expect(paginationFor(listAction({ cursor: 'string', page: 'integer' })).model).toBe('cursor');
  });

  it('finds a next marker nested in an envelope', () => {
    const info = paginationFor(
      listAction({ cursor: 'string' }, { meta: { type: 'object', properties: { has_more: { type: 'boolean' } } } }),
    );
    expect(info.hasMoreField).toBe('response.meta.has_more');
  });
});

describe('paginationFor — page and offset', () => {
  it('detects page numbering', () => {
    const info = paginationFor(listAction({ page: 'integer', per_page: 'integer' }, { total_count: { type: 'integer' } }));
    expect(info.model).toBe('page');
    expect(info.pageParam).toBe('page');
    expect(info.sizeParam).toBe('per_page');
    expect(info.totalField).toBe('response.total_count');
    expect(info.confidence).toBe('high');
  });

  it('detects offset pagination and warns about shifting rows', () => {
    const info = paginationFor(listAction({ offset: 'integer', limit: 'integer' }));
    expect(info.model).toBe('offset');
    expect(info.offsetParam).toBe('offset');
    expect(info.note).toContain('shift');
  });

  it('recognises skip/start as offsets', () => {
    for (const name of ['skip', 'start', 'start_index']) {
      expect(paginationFor(listAction({ [name]: 'integer' })).model).toBe('offset');
    }
  });

  it('tells the caller how to stop when a total is documented', () => {
    expect(paginationFor(listAction({ page: 'integer' }, { total: { type: 'integer' } })).note).toContain('Stop using');
  });

  it('falls back to short-page advice when no total is documented', () => {
    expect(paginationFor(listAction({ page: 'integer' })).note).toContain('short');
  });
});

describe('paginationFor — link-style and none', () => {
  it('treats a next field with no request parameter as follow-the-link', () => {
    const info = paginationFor(listAction({}, { next: { type: 'string' } }));
    expect(info.model).toBe('cursor');
    expect(info.confidence).toBe('medium');
    expect(info.note).toContain('follow-the-link');
  });

  // A size cap alone is truncation, not pagination — claiming otherwise sends
  // an agent hunting for a page 2 that does not exist.
  it('does not call a bare size limit pagination', () => {
    const info = paginationFor(listAction({ limit: 'integer' }));
    expect(info.model).toBe('none');
    expect(info.sizeParam).toBe('limit');
    expect(info.note).toContain('whole result set');
  });

  it('reports none for an ordinary read with no pagination markers', () => {
    const info = paginationFor(listAction({ q: 'string' }));
    expect(info.model).toBe('none');
    expect(info.confidence).toBe('high');
  });

  it('never paginates a write operation', () => {
    const post = action({
      name: 'create_thing',
      method: 'POST',
      path: '/things',
      safety: 'write',
      paramsSchema: query({ limit: 'integer', cursor: 'string' }),
    });
    const info = paginationFor(post);
    expect(info.model).toBe('none');
    expect(info.note).toContain('Not a read operation');
  });

  it('handles an operation with no parameters at all', () => {
    expect(paginationFor(action({ name: 'ping', method: 'GET', path: '/ping' })).model).toBe('none');
  });
});
