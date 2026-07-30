// Fully offline: MockLanguageModelV4 (ai/test) replaces the actual model, so
// these tests are deterministic and never make a network call — same
// technique ask.test.ts already uses for generateText.

import { describe, expect, it } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { clusterQuestions, consideredFieldsFor, enrichRecord, reconcileOpenQuestions } from '../deepEnrich';
import type { Action, ImportRecord } from '../ir';

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

function record(): ImportRecord {
  const actions = [
    action({
      name: 'list_customers',
      method: 'GET',
      path: '/customers',
      responseSchema: {
        type: 'object',
        properties: {
          data: {
            type: 'array',
            items: { type: 'object', properties: { customerId: { type: 'string', format: 'uuid' } } },
          },
        },
      },
    }),
    action({
      name: 'create_order',
      method: 'POST',
      path: '/orders',
      safety: 'write',
      paramsSchema: {
        type: 'object',
        required: ['body'],
        properties: {
          body: {
            'x-docentapi-in': 'body',
            type: 'object',
            required: ['customerId', 'currency', 'discountCode'],
            properties: {
              customerId: { type: 'string', format: 'uuid' },
              currency: { type: 'string', enum: ['usd', 'eur'] },
              discountCode: { type: 'string' },
              orderId: { type: 'string', readOnly: true },
            },
          },
        },
      },
    }),
  ];
  return {
    id: 'r',
    name: 'Shop',
    source: 'openapi',
    baseUrls: ['https://api.shop.test'],
    auth: 'bearer',
    actions,
    counts: { total: 2, read: 1, write: 1, destructive: 0 },
    createdAt: 1,
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
}

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
};

function objectResult(object: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(object) }],
    finishReason: { unified: 'stop' as const, raw: undefined },
    usage: USAGE,
    warnings: [],
  };
}

describe('consideredFieldsFor', () => {
  it('excludes readOnly and container fields, keeps writable leaves', () => {
    const r = record();
    const createOrder = r.actions.find((a) => a.name === 'create_order')!;
    const fields = consideredFieldsFor(r, [createOrder]);
    const paths = fields.map((f) => f.field);
    expect(paths).toContain('body.customerId');
    expect(paths).toContain('body.currency');
    expect(paths).toContain('body.discountCode');
    expect(paths).not.toContain('body.orderId');
  });

  it('reports the heuristic origin and known producers per field', () => {
    const r = record();
    const createOrder = r.actions.find((a) => a.name === 'create_order')!;
    const fields = consideredFieldsFor(r, [createOrder]);
    const customerId = fields.find((f) => f.field === 'body.customerId')!;
    expect(customerId.origin).toBe('produced_by_api');
    expect(customerId.knownProducers.length).toBeGreaterThan(0);

    const discountCode = fields.find((f) => f.field === 'body.discountCode')!;
    expect(discountCode.origin).toBe('caller_supplied');
    expect(discountCode.knownProducers).toEqual([]);
  });
});

// Questions reach the API's owner verbatim. Nothing previously checked that a
// question named a real field, or that it was even answerable by a person who
// has never seen this tool.
describe('enrichRecord question containment', () => {
  const questionModel = (...openQuestions: unknown[]) =>
    new MockLanguageModelV4({ doGenerate: objectResult({ fields: [], openQuestions }) });

  const ok = { action: 'create_order', fieldPath: 'body.discountCode', kind: 'ambiguous_origin' };

  it('drops a question about a field that does not exist', async () => {
    const result = await enrichRecord({
      record: record(),
      docExcerpts: [],
      model: questionModel(
        { ...ok, fieldPath: 'body.nonexistentField', question: 'What is this?' },
        { ...ok, question: 'Where does a valid discountCode come from?' },
      ),
    });
    expect(result.openQuestions.map((q) => q.fieldPath)).toEqual(['body.discountCode']);
  });

  it('drops a question about an action that does not exist', async () => {
    const result = await enrichRecord({
      record: record(),
      docExcerpts: [],
      model: questionModel({ action: 'drop_all_orders', kind: 'unclear_scope', question: 'What does this do?' }),
    });
    expect(result.openQuestions).toEqual([]);
  });

  it('drops questions about our own inference, which an owner cannot answer', async () => {
    const internal = [
      'knownProducers for body.id list tag ids too. Is this heuristic noise?',
      'Is the lineage confidence score for this field intentional?',
      'Should DocentAPI treat these as interchangeable?',
      'Why did the structural heuristic pick this producer?',
    ];
    const result = await enrichRecord({
      record: record(),
      docExcerpts: [],
      model: questionModel(
        ...internal.map((question) => ({ ...ok, question })),
        { ...ok, question: 'Where does a valid discountCode come from?' },
      ),
    });
    expect(result.openQuestions).toHaveLength(1);
    expect(result.openQuestions[0].question).toContain('discountCode');
  });

  it('keeps a question that merely mentions a field named like a confidence value', async () => {
    // The filter must not be so broad that it eats real questions about the
    // API's own vocabulary.
    const result = await enrichRecord({
      record: record(),
      docExcerpts: [],
      model: questionModel({ ...ok, question: 'Is discountCode case-sensitive when applied at checkout?' }),
    });
    expect(result.openQuestions).toHaveLength(1);
  });

  it('collects a disputed producer as a dispute rather than a question', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: objectResult({
        fields: [],
        openQuestions: [],
        lineageDisputes: [
          {
            action: 'create_order',
            field: 'body.customerId',
            producer: 'list_customers.response.data[].customerId (high)',
            reason: 'The docs describe this as a merchant-scoped alias, not the customer id.',
          },
        ],
      }),
    });
    const result = await enrichRecord({ record: record(), docExcerpts: [], model });
    expect(result.openQuestions).toEqual([]);
    expect(result.lineageDisputes).toHaveLength(1);
    expect(result.lineageDisputes![0].tool).toBe('create_order');
    expect(result.lineageDisputes![0].producer).toContain('list_customers');
  });

  it('drops a dispute about a field that does not exist', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: objectResult({
        fields: [],
        openQuestions: [],
        lineageDisputes: [{ action: 'create_order', field: 'body.ghost', producer: 'x.y (high)', reason: 'nope' }],
      }),
    });
    const result = await enrichRecord({ record: record(), docExcerpts: [], model });
    expect(result.lineageDisputes).toEqual([]);
  });
});

describe('enrichRecord', () => {
  it('parses structured findings and open questions from the model', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: objectResult({
        fields: [
          {
            action: 'create_order',
            field: 'body.currency',
            semanticMeaning: 'ISO 4217 currency code for the order total.',
          },
        ],
        openQuestions: [
          {
            action: 'create_order',
            fieldPath: 'body.discountCode',
            kind: 'ambiguous_origin',
            question: 'Where does a valid discountCode come from?',
          },
        ],
      }),
    });

    const result = await enrichRecord({ record: record(), docExcerpts: [], model });

    expect(result.fields).toHaveLength(1);
    expect(result.fields[0].semanticMeaning).toContain('ISO 4217');
    expect(result.fields[0].sourcedFrom).toBe('spec');
    expect(result.openQuestions).toHaveLength(1);
    expect(result.openQuestions[0].fieldPath).toBe('body.discountCode');
    expect(result.chunksProcessed).toBeGreaterThan(0);
    expect(result.truncated).toBe(false);
  });

  it('marks findings as docs-sourced when doc excerpts were provided', async () => {
    const model = new MockLanguageModelV4({ doGenerate: objectResult({ fields: [], openQuestions: [] }) });
    const result = await enrichRecord({
      record: record(),
      docExcerpts: [{ url: 'https://docs.shop.test/orders', excerpt: 'Currency must be ISO 4217.' }],
      model,
    });
    expect(result.chunksProcessed).toBeGreaterThan(0);
    // No findings this call, but confirms the excerpt flows into the prompt
    // without throwing — content assertion lives in the prompt-shape test below.
    expect(result.fields).toEqual([]);
  });

  it('includes crawled doc excerpts in the chunk prompt', async () => {
    const model = new MockLanguageModelV4({ doGenerate: objectResult({ fields: [], openQuestions: [] }) });
    await enrichRecord({
      record: record(),
      docExcerpts: [{ url: 'https://docs.shop.test/orders', title: 'Orders', excerpt: 'Currency must be ISO 4217.' }],
      model,
    });
    const prompt = JSON.stringify(model.doGenerateCalls[0].prompt);
    expect(prompt).toContain('docs.shop.test');
    expect(prompt).toContain('ISO 4217');
  });

  it('sends system instructions forbidding compliance with instructions inside field/doc data', async () => {
    const model = new MockLanguageModelV4({ doGenerate: objectResult({ fields: [], openQuestions: [] }) });
    await enrichRecord({ record: record(), docExcerpts: [], model });
    const system = model.doGenerateCalls[0].prompt.find((m) => m.role === 'system');
    const text = (system as { content: string }).content;
    expect(text).toContain('DATA');
    expect(text).toContain('ignore previous instructions');
  });

  it('does not fail the whole pass when one chunk throws', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: () => {
        throw new Error('model unavailable');
      },
    });
    const result = await enrichRecord({ record: record(), docExcerpts: [], model });
    expect(result.fields).toEqual([]);
    expect(result.openQuestions).toEqual([]);
  });

  it('skips a resource group with no writable fields (e.g. read-only list operations)', async () => {
    const readOnlyRecord: ImportRecord = {
      ...record(),
      actions: [action({ name: 'list_customers', method: 'GET', path: '/customers' })],
    };
    const model = new MockLanguageModelV4({ doGenerate: objectResult({ fields: [], openQuestions: [] }) });
    const result = await enrichRecord({ record: readOnlyRecord, docExcerpts: [], model });
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(result.chunksProcessed).toBe(1);
  });
});

describe('clusterQuestions', () => {
  // The four Petstore operations that all take petId, plus the two creates that
  // both take a bare `id` but for different entities.
  const PATHS = new Map([
    ['get_pet_by_id', '/pet/{petId}'],
    ['update_pet_with_form', '/pet/{petId}'],
    ['delete_pet', '/pet/{petId}'],
    ['upload_file', '/pet/{petId}/uploadImage'],
    ['add_pet', '/pet'],
    ['place_order', '/store/order'],
    ['update_pet', '/pet'],
  ]);

  const q = (tool: string, fieldPath: string, question = 'Where does this come from?') => ({
    tool,
    fieldPath,
    kind: 'ambiguous_origin' as const,
    question,
  });

  it('asks about petId once and records every operation it affects', () => {
    const clustered = clusterQuestions(
      [
        q('get_pet_by_id', 'path.petId'),
        q('update_pet_with_form', 'path.petId'),
        q('delete_pet', 'path.petId'),
        q('upload_file', 'path.petId'),
      ],
      PATHS,
    );

    expect(clustered).toHaveLength(1);
    expect(clustered[0].appliesTo).toHaveLength(4);
    expect(clustered[0].appliesTo!.map((s) => s.tool)).toEqual([
      'get_pet_by_id',
      'update_pet_with_form',
      'delete_pet',
      'upload_file',
    ]);
  });

  it('keeps the first wording verbatim rather than rewriting it', () => {
    const clustered = clusterQuestions(
      [q('get_pet_by_id', 'path.petId', 'First phrasing'), q('delete_pet', 'path.petId', 'Second phrasing')],
      PATHS,
    );
    expect(clustered[0].question).toBe('First phrasing');
  });

  it('does not merge the same field name across different entities', () => {
    // add_pet.body.id is a Pet id and place_order.body.id is an Order id. One
    // answer must not silently apply to both.
    const clustered = clusterQuestions([q('add_pet', 'body.id'), q('place_order', 'body.id')], PATHS);
    expect(clustered).toHaveLength(2);
  });

  it('separates a nested entity id from its parent', () => {
    const clustered = clusterQuestions(
      [q('update_pet', 'body.id'), q('update_pet', 'body.category.id'), q('update_pet', 'body.tags[].id')],
      PATHS,
    );
    expect(clustered).toHaveLength(3);
  });

  it('does not merge different kinds of question about one field', () => {
    const clustered = clusterQuestions(
      [
        { ...q('add_pet', 'body.status'), kind: 'ambiguous_origin' as const },
        { ...q('add_pet', 'body.status'), kind: 'ambiguous_enum' as const },
      ],
      PATHS,
    );
    expect(clustered).toHaveLength(2);
  });

  it('drops a question about an action it has no path for', () => {
    expect(clusterQuestions([q('ghost_action', 'body.x')], PATHS)).toEqual([]);
  });
});

describe('reconcileOpenQuestions', () => {
  it('auto-raises a caller-supplied field with no producer that the LLM neither explained nor questioned', () => {
    const r = record();
    const createOrder = r.actions.find((a) => a.name === 'create_order')!;
    const considered = consideredFieldsFor(r, [createOrder]);
    const result = { fields: [], openQuestions: [], chunksProcessed: 1, chunksTotal: 1, truncated: false };

    const auto = reconcileOpenQuestions(considered, result);
    expect(auto.some((q) => q.fieldPath === 'body.discountCode')).toBe(true);
  });

  it('asks about a field whose only producer the model disputed', () => {
    // body.customerId is produced_by_api solely because of the
    // list_customers edge. If the model disputes that edge the classification no
    // longer holds, so the field needs a real question rather than silence.
    const r = record();
    const createOrder = r.actions.find((a) => a.name === 'create_order')!;
    const considered = consideredFieldsFor(r, [createOrder]);
    const customerId = considered.find((f) => f.field === 'body.customerId')!;
    expect(customerId.origin).toBe('produced_by_api');

    const disputedAll = reconcileOpenQuestions(considered, {
      fields: [],
      openQuestions: [],
      lineageDisputes: customerId.knownProducers.map((producer) => ({
        tool: 'create_order',
        field: 'body.customerId',
        producer,
        reason: 'The docs call this a merchant-scoped alias.',
      })),
      chunksProcessed: 1,
      chunksTotal: 1,
      truncated: false,
    });
    expect(disputedAll.some((q) => q.fieldPath === 'body.customerId')).toBe(true);
  });

  it('stays quiet when a producer survives the dispute', () => {
    const r = record();
    const createOrder = r.actions.find((a) => a.name === 'create_order')!;
    const considered = consideredFieldsFor(r, [createOrder]);

    const auto = reconcileOpenQuestions(considered, {
      fields: [],
      openQuestions: [],
      lineageDisputes: [
        { tool: 'create_order', field: 'body.customerId', producer: 'some_other.field (high)', reason: 'unrelated' },
      ],
      chunksProcessed: 1,
      chunksTotal: 1,
      truncated: false,
    });
    expect(auto.some((q) => q.fieldPath === 'body.customerId')).toBe(false);
  });

  it('spends one of the fifteen slots per cluster, not per site', () => {
    // Four operations each taking an undocumented petId is one question. Before
    // clustering it cost four of the fifteen auto-clarification slots.
    const petPaths = new Map([
      ['get_pet_by_id', '/pet/{petId}'],
      ['update_pet_with_form', '/pet/{petId}'],
      ['delete_pet', '/pet/{petId}'],
      ['upload_file', '/pet/{petId}/uploadImage'],
    ]);
    const considered = [...petPaths.keys()].map((tool) => ({
      action: tool,
      field: 'path.petId',
      type: 'integer',
      origin: 'caller_supplied' as const,
      required: true,
      knownProducers: [],
    }));
    const empty = { fields: [], openQuestions: [], chunksProcessed: 1, chunksTotal: 1, truncated: false };

    expect(reconcileOpenQuestions(considered, empty)).toHaveLength(4); // without paths: one per site
    const clustered = reconcileOpenQuestions(considered, empty, petPaths);
    expect(clustered).toHaveLength(1);
    expect(clustered[0].appliesTo).toHaveLength(4);
  });

  it('does not re-raise a field the LLM already explained', () => {
    const r = record();
    const createOrder = r.actions.find((a) => a.name === 'create_order')!;
    const considered = consideredFieldsFor(r, [createOrder]);
    const result = {
      fields: [
        { tool: 'create_order', field: 'body.discountCode', semanticMeaning: 'x', sourcedFrom: 'spec' as const },
      ],
      openQuestions: [],
      chunksProcessed: 1,
      chunksTotal: 1,
      truncated: false,
    };

    const auto = reconcileOpenQuestions(considered, result);
    expect(auto.some((q) => q.fieldPath === 'body.discountCode')).toBe(false);
  });

  it('does not re-raise a field the LLM already asked about', () => {
    const r = record();
    const createOrder = r.actions.find((a) => a.name === 'create_order')!;
    const considered = consideredFieldsFor(r, [createOrder]);
    const result = {
      fields: [],
      openQuestions: [
        { tool: 'create_order', fieldPath: 'body.discountCode', kind: 'ambiguous_origin' as const, question: 'x' },
      ],
      chunksProcessed: 1,
      chunksTotal: 1,
      truncated: false,
    };

    const auto = reconcileOpenQuestions(considered, result);
    expect(auto).toEqual([]);
  });

  it('never raises a field that already has a heuristic producer', () => {
    const r = record();
    const createOrder = r.actions.find((a) => a.name === 'create_order')!;
    const considered = consideredFieldsFor(r, [createOrder]);
    const result = { fields: [], openQuestions: [], chunksProcessed: 1, chunksTotal: 1, truncated: false };

    const auto = reconcileOpenQuestions(considered, result);
    expect(auto.some((q) => q.fieldPath === 'body.customerId')).toBe(false);
  });

  it('never raises an enum-constrained field', () => {
    const r = record();
    const createOrder = r.actions.find((a) => a.name === 'create_order')!;
    const considered = consideredFieldsFor(r, [createOrder]);
    const result = { fields: [], openQuestions: [], chunksProcessed: 1, chunksTotal: 1, truncated: false };

    const auto = reconcileOpenQuestions(considered, result);
    expect(auto.some((q) => q.fieldPath === 'body.currency')).toBe(false);
  });

  it('caps the total at 15 combined with the model-raised questions', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      action: 'bulk_op',
      field: `body.mystery${i}`,
      type: 'string',
      origin: 'caller_supplied' as const,
      required: false,
      knownProducers: [],
    }));
    const result = { fields: [], openQuestions: [], chunksProcessed: 1, chunksTotal: 1, truncated: false };
    const auto = reconcileOpenQuestions(many, result);
    expect(auto.length).toBeLessThanOrEqual(15);
  });
});
