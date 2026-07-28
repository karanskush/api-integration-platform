// Driven by the four questions that genuinely survived the Petstore run — the
// ones a person really does have to answer. Each should land on an archetype
// whose answer space is a handful of taps rather than a blank box.

import { describe, expect, it } from 'vitest';
import { classify, originForAnswer } from '../archetypes';
import type { FieldNode } from '../../fieldMap';
import type { Action } from '../../ir';
import type { LineageEdge } from '../../lineage';

function action(o: Partial<Action> & { name: string; method: string; path: string }): Action {
  return {
    id: `id_${o.name}`,
    description: `Does ${o.name}`,
    paramsSchema: { type: 'object', properties: {} },
    auth: 'bearer',
    safety: 'read',
    examples: [],
    ...o,
  } as Action;
}

function field(o: Partial<FieldNode> & { path: string; name: string }): FieldNode {
  return { location: 'body', type: 'string', required: false, nullable: false, ...o } as FieldNode;
}

const edge = (tool: string, f: string, confidence: LineageEdge['confidence']): LineageEdge => ({
  from: { tool, field: f },
  to: { tool: 'x', field: 'y' },
  confidence,
  score: 50,
  why: ['distinctive_name'],
});

describe('classify', () => {
  it('asks who owns the id on a create', () => {
    // Petstore: Pet.id is writable on POST /pet and nothing says whether the
    // server honours what you send.
    const result = classify(
      action({ name: 'add_pet', method: 'POST', path: '/pet', safety: 'write' }),
      field({ path: 'body.id', name: 'id', type: 'integer', format: 'int64' }),
      [],
    );
    expect(result.archetype).toBe('identifier_ownership');
    expect(result.answerSpec.kind).toBe('single_choice');
    expect(result.answerSpec.options.map((o) => o.value)).toEqual(['server_assigns', 'caller_assigns', 'either']);
    expect(originForAnswer(result.answerSpec, 'server_assigns')).toBe('server_generated');
    expect(originForAnswer(result.answerSpec, 'caller_assigns')).toBe('caller_supplied');
  });

  it('does not ask who owns the id when updating an existing record', () => {
    const result = classify(
      action({ name: 'update_pet', method: 'PUT', path: '/pet/{petId}', safety: 'write' }),
      field({ path: 'body.id', name: 'id', type: 'integer' }),
      [],
    );
    expect(result.archetype).not.toBe('identifier_ownership');
  });

  it('offers the actual candidate producers when lineage cannot choose', () => {
    const result = classify(
      action({ name: 'create_order', method: 'POST', path: '/orders', safety: 'write' }),
      field({ path: 'body.customerId', name: 'customerId' }),
      [edge('list_customers', 'response[].id', 'medium'), edge('create_customer', 'response.id', 'medium')],
    );
    expect(result.archetype).toBe('producer_disambiguation');
    // The options ARE the candidates — nothing invented.
    expect(result.answerSpec.options.map((o) => o.value)).toEqual([
      'list_customers.response[].id',
      'create_customer.response.id',
      'none_of_these',
    ]);
    expect(originForAnswer(result.answerSpec, 'none_of_these')).toBe('caller_supplied');
  });

  it('stays quiet about producers when one is already high confidence', () => {
    const result = classify(
      action({ name: 'get_pet', method: 'GET', path: '/pet/{petId}' }),
      field({ path: 'path.petId', name: 'petId', location: 'path', required: true }),
      [edge('add_pet', 'response.id', 'high')],
    );
    expect(result.archetype).not.toBe('producer_disambiguation');
  });

  it('flags a description that describes a different operation', () => {
    // Petstore's PUT /user/{username} describes its own path parameter as
    // "name that need to be deleted" — a copy-paste from delete_user.
    const result = classify(
      action({ name: 'update_user', method: 'PUT', path: '/user/{username}', safety: 'write' }),
      field({ path: 'path.username', name: 'username', location: 'path', required: true, description: 'name that need to be deleted' }),
      [],
    );
    expect(result.archetype).toBe('description_contradicts_operation');
    expect(result.why).toContain('deleted');
  });

  it('does not flag a description whose verb matches the operation', () => {
    const result = classify(
      action({ name: 'delete_user', method: 'DELETE', path: '/user/{username}', safety: 'destructive' }),
      field({ path: 'path.username', name: 'username', location: 'path', required: true, description: 'name that need to be deleted' }),
      [],
    );
    expect(result.archetype).not.toBe('description_contradicts_operation');
  });

  it('asks what an undocumented code means', () => {
    // Petstore's User.userStatus: int32, described only as "User Status".
    const result = classify(
      action({ name: 'create_user', method: 'POST', path: '/user', safety: 'write' }),
      field({ path: 'body.userStatus', name: 'userStatus', type: 'integer', format: 'int32', description: 'User Status' }),
      [],
    );
    expect(result.archetype).toBe('undocumented_code_semantics');
    expect(result.answerSpec.kind).toBe('open_values');
  });

  it('leaves a documented code alone', () => {
    const result = classify(
      action({ name: 'create_user', method: 'POST', path: '/user', safety: 'write' }),
      field({
        path: 'body.userStatus',
        name: 'userStatus',
        type: 'integer',
        description: '1 = active, 2 = suspended, 3 = closed.',
      }),
      [],
    );
    expect(result.archetype).not.toBe('undocumented_code_semantics');
  });

  it('asks how to format a bare string whose name promises a shape', () => {
    const result = classify(
      action({ name: 'place_order', method: 'POST', path: '/store/order', safety: 'write' }),
      field({ path: 'body.shipDate', name: 'shipDate', type: 'string' }),
      [],
    );
    expect(result.archetype).toBe('format_or_shape');
    expect(result.answerSpec.options.some((o) => o.value === 'iso8601_datetime')).toBe(true);
  });

  it('leaves a string alone when the spec already declares its format', () => {
    const result = classify(
      action({ name: 'place_order', method: 'POST', path: '/store/order', safety: 'write' }),
      field({ path: 'body.shipDate', name: 'shipDate', type: 'string', format: 'date-time' }),
      [],
    );
    expect(result.archetype).not.toBe('format_or_shape');
  });

  it('asks whether a PUT body replaces or merges', () => {
    const result = classify(
      action({ name: 'replace_pet', method: 'PUT', path: '/pet/{petId}', safety: 'write' }),
      field({ path: 'body.name', name: 'name', location: 'body' }),
      [],
    );
    expect(result.archetype).toBe('scope_of_effect');
  });

  it('falls back to the origin picker, which is still a closed choice', () => {
    const result = classify(
      action({ name: 'do_thing', method: 'POST', path: '/things', safety: 'write' }),
      field({ path: 'body.widgetRef', name: 'widgetRef', required: true }),
      [],
    );
    expect(result.archetype).toBe('origin_unknown');
    expect(result.answerSpec.kind).toBe('single_choice');
    expect(result.answerSpec.options).toHaveLength(5); // the five FieldOrigin values
    expect(originForAnswer(result.answerSpec, 'server_generated')).toBe('server_generated');
  });
});

// The point of the taxonomy is that a person is never handed a blank box. That
// is a property worth gating in CI rather than asserting in a comment.
describe('answer-space coverage', () => {
  const CORPUS: Array<[Action, FieldNode, LineageEdge[]]> = [
    [action({ name: 'add_pet', method: 'POST', path: '/pet', safety: 'write' }), field({ path: 'body.id', name: 'id', type: 'integer' }), []],
    [action({ name: 'add_pet', method: 'POST', path: '/pet', safety: 'write' }), field({ path: 'body.name', name: 'name', required: true }), []],
    [action({ name: 'add_pet', method: 'POST', path: '/pet', safety: 'write' }), field({ path: 'body.photoUrls[]', name: 'photoUrls', required: true }), []],
    [action({ name: 'add_pet', method: 'POST', path: '/pet', safety: 'write' }), field({ path: 'body.status', name: 'status' }), []],
    [action({ name: 'get_pet', method: 'GET', path: '/pet/{petId}' }), field({ path: 'path.petId', name: 'petId', location: 'path', required: true }), []],
    [action({ name: 'place_order', method: 'POST', path: '/store/order', safety: 'write' }), field({ path: 'body.shipDate', name: 'shipDate' }), []],
    [action({ name: 'place_order', method: 'POST', path: '/store/order', safety: 'write' }), field({ path: 'body.quantity', name: 'quantity', type: 'integer' }), []],
    [action({ name: 'create_user', method: 'POST', path: '/user', safety: 'write' }), field({ path: 'body.userStatus', name: 'userStatus', type: 'integer', description: 'User Status' }), []],
    [action({ name: 'update_user', method: 'PUT', path: '/user/{username}', safety: 'write' }), field({ path: 'path.username', name: 'username', location: 'path', required: true, description: 'name that need to be deleted' }), []],
    [action({ name: 'upload_file', method: 'POST', path: '/pet/{petId}/uploadImage', safety: 'write' }), field({ path: 'body', name: 'body', required: true }), []],
    [action({ name: 'create_order', method: 'POST', path: '/orders', safety: 'write' }), field({ path: 'body.customerId', name: 'customerId' }), [edge('list_customers', 'response[].id', 'medium')]],
  ];

  it('never hands anyone a blank box', () => {
    for (const [a, f, producers] of CORPUS) {
      const { archetype, answerSpec } = classify(a, f, producers);
      expect(answerSpec.kind, `${a.name} ${f.path} (${archetype})`).not.toBe('free_text');
    }
  });

  it('always leaves an escape hatch, so the quiz cannot force a wrong answer', () => {
    for (const [a, f, producers] of CORPUS) {
      expect(classify(a, f, producers).answerSpec.allowOther, `${a.name} ${f.path}`).toBe(true);
    }
  });

  it('keeps single-choice spaces small enough to scan', () => {
    for (const [a, f, producers] of CORPUS) {
      const { answerSpec } = classify(a, f, producers);
      if (answerSpec.kind !== 'single_choice') continue;
      expect(answerSpec.options.length, `${a.name} ${f.path}`).toBeGreaterThan(0);
      expect(answerSpec.options.length, `${a.name} ${f.path}`).toBeLessThanOrEqual(7);
    }
  });

  it('orders concrete questions ahead of open-ended ones', () => {
    const ranked = CORPUS.map(([a, f, p]) => classify(a, f, p)).sort((x, y) => x.rank - y.rank);
    expect(ranked[0].rank).toBeLessThan(ranked[ranked.length - 1].rank);
    expect(ranked[ranked.length - 1].archetype).toBe('origin_unknown');
  });

  it('explains why it is asking and what answering unlocks', () => {
    for (const [a, f, producers] of CORPUS) {
      const { why, unlocks } = classify(a, f, producers);
      expect(why.length, `${a.name} ${f.path}`).toBeGreaterThan(20);
      expect(unlocks.length, `${a.name} ${f.path}`).toBeGreaterThan(20);
    }
  });
});
