import { describe, expect, it } from 'vitest';
import { computeLineage, consumersFor, findFieldsByName, lineageFor, producersFor } from '../lineage';
import type { Action, ImportRecord } from '../ir';

function action(overrides: Partial<Action> & { name: string; method: string; path: string }): Action {
  return {
    id: `id_${overrides.name}`,
    description: `Does ${overrides.name}`,
    paramsSchema: { type: 'object', properties: {} },
    auth: 'bearer',
    safety: 'read',
    examples: [],
    ...overrides,
  } as Action;
}

function param(where: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { 'x-spotcheck-in': where, ...extra };
}

function record(actions: Action[]): ImportRecord {
  const counts = { total: actions.length, read: 0, write: 0, destructive: 0 };
  for (const a of actions) counts[a.safety]++;
  return {
    id: 'lineage-test',
    name: 'Lineage Test',
    source: 'openapi',
    baseUrls: ['https://api.test'],
    auth: 'bearer',
    actions,
    counts,
    createdAt: 1,
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
}

function edgeLabels(graph: ReturnType<typeof computeLineage>): string[] {
  return graph.edges.map((e) => `${e.from.tool}.${e.from.field} -> ${e.to.tool}.${e.to.field}`);
}

// A REST API: list/create produce ids, item routes consume them.
const REST = [
  action({
    name: 'list_customers',
    method: 'GET',
    path: '/v1/customers',
    responseSchema: {
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, email: { type: 'string', format: 'email' } } },
    },
  }),
  action({
    name: 'create_customer',
    method: 'POST',
    path: '/v1/customers',
    safety: 'write',
    responseSchema: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
  }),
  action({
    name: 'create_order',
    method: 'POST',
    path: '/v1/orders',
    safety: 'write',
    paramsSchema: {
      type: 'object',
      required: ['body'],
      properties: {
        body: param('body', {
          type: 'object',
          required: ['customerId'],
          properties: {
            customerId: { type: 'string', format: 'uuid' },
            note: { type: 'string' },
          },
        }),
      },
    },
    responseSchema: { type: 'object', properties: { id: { type: 'string' } } },
  }),
];

describe('computeLineage — the core case', () => {
  const graph = computeLineage(record(REST));

  // THE question: "where does this body field come from?" — previously untraced
  // entirely, because the body was one opaque blob.
  it('traces a nested body field back to the producing operation', () => {
    const edges = producersFor(graph, 'create_order', 'body.customerId');
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.map((e) => e.from.tool)).toContain('list_customers');
  });

  it('matches a foreign-key-shaped name against a bare id on the right resource', () => {
    const edge = producersFor(graph, 'create_order', 'body.customerId').find((e) => e.from.tool === 'list_customers');
    expect(edge?.why).toContain('foreign_key_name');
    expect(edge?.from.field).toBe('response[].id');
  });

  it('offers the create as a producer too', () => {
    expect(producersFor(graph, 'create_order', 'body.customerId').map((e) => e.from.tool)).toContain('create_customer');
  });

  it('rates a foreign-key + resource + format match as high confidence', () => {
    const edge = producersFor(graph, 'create_order', 'body.customerId')[0];
    expect(edge.confidence).toBe('high');
    expect(edge.why).toContain('format_match');
  });

  // The reverse direction, entirely absent before: "I have a customer id — what
  // accepts it?" This is how an agent plans forward.
  it('answers the reverse direction', () => {
    const edges = consumersFor(graph, 'list_customers', 'response[].id');
    expect(edges.map((e) => e.to.tool)).toContain('create_order');
  });

  it('never emits a self-edge', () => {
    for (const edge of graph.edges) expect(edge.from.tool).not.toBe(edge.to.tool);
  });

  it('leaves a genuinely caller-supplied field unproduced', () => {
    expect(producersFor(graph, 'create_order', 'body.note')).toEqual([]);
  });

  it('reports stats so coverage is inspectable', () => {
    expect(graph.stats.producerFields).toBeGreaterThan(0);
    expect(graph.stats.consumerFields).toBeGreaterThan(0);
    expect(graph.stats.emitted).toBe(graph.edges.length);
  });
});

describe('computeLineage — refuses wrong edges', () => {
  // The negative test the plan calls for: two unrelated resources both exposing
  // `id` must not be linked. This is the edge class that gets an agent to act
  // on the wrong object.
  it('does not link a bare id across unrelated resources', () => {
    const graph = computeLineage(
      record([
        action({
          name: 'list_invoices',
          method: 'GET',
          path: '/invoices',
          responseSchema: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } },
        }),
        action({
          name: 'delete_widget',
          method: 'DELETE',
          path: '/widgets/{id}',
          safety: 'destructive',
          paramsSchema: { type: 'object', required: ['id'], properties: { id: param('path', { type: 'string' }) } },
        }),
      ]),
    );
    expect(edgeLabels(graph)).toEqual([]);
  });

  it('does not link two unrelated fields that merely share a generic name', () => {
    const graph = computeLineage(
      record([
        action({
          name: 'get_weather',
          method: 'GET',
          path: '/weather',
          responseSchema: { type: 'object', properties: { status: { type: 'string' } } },
        }),
        action({
          name: 'update_shipment',
          method: 'POST',
          path: '/shipments',
          safety: 'write',
          paramsSchema: {
            type: 'object',
            properties: { body: param('body', { type: 'object', properties: { status: { type: 'string' } } }) },
          },
        }),
      ]),
    );
    expect(edgeLabels(graph)).toEqual([]);
  });

  it('links a generic name when overlapping enums make it distinctive', () => {
    const graph = computeLineage(
      record([
        action({
          name: 'get_shipment_status',
          method: 'GET',
          path: '/shipments/status',
          responseSchema: { type: 'object', properties: { status: { type: 'string', enum: ['queued', 'shipped'] } } },
        }),
        action({
          name: 'set_status',
          method: 'POST',
          path: '/other',
          safety: 'write',
          paramsSchema: {
            type: 'object',
            properties: {
              body: param('body', { type: 'object', properties: { status: { type: 'string', enum: ['queued', 'shipped'] } } }),
            },
          },
        }),
      ]),
    );
    expect(graph.edges.some((e) => e.why.includes('enum_overlap'))).toBe(true);
  });

  it('does not trace a readOnly request field, which the caller never sends', () => {
    const graph = computeLineage(
      record([
        action({
          name: 'list_pets',
          method: 'GET',
          path: '/pets',
          responseSchema: { type: 'array', items: { type: 'object', properties: { petId: { type: 'string' } } } },
        }),
        action({
          name: 'create_pet',
          method: 'POST',
          path: '/pets',
          safety: 'write',
          paramsSchema: {
            type: 'object',
            properties: { body: param('body', { type: 'object', properties: { petId: { type: 'string', readOnly: true } } }) },
          },
        }),
      ]),
    );
    expect(producersFor(graph, 'create_pet', 'body.petId')).toEqual([]);
  });

  it('does not link containers, which carry no value', () => {
    const graph = computeLineage(
      record([
        action({
          name: 'get_thing',
          method: 'GET',
          path: '/things',
          responseSchema: { type: 'object', properties: { customer: { type: 'object', properties: { a: { type: 'string' } } } } },
        }),
        action({
          name: 'post_thing',
          method: 'POST',
          path: '/things2',
          safety: 'write',
          paramsSchema: {
            type: 'object',
            properties: {
              body: param('body', { type: 'object', properties: { customer: { type: 'object', properties: { a: { type: 'string' } } } } }),
            },
          },
        }),
      ]),
    );
    // The container itself is not an edge; only its scalar leaf can be.
    expect(graph.edges.every((e) => !e.to.field.endsWith('.customer'))).toBe(true);
  });
});

describe('computeLineage — RPC-style APIs', () => {
  // Slack-shaped: `conversations.list` and `chat.postMessage` share no URL path
  // segment, so path affinity alone cannot carry the match. This proves the
  // name/title signals are doing real work.
  const RPC = [
    action({
      name: 'conversations_list',
      method: 'GET',
      path: '/api/conversations.list',
      responseSchema: {
        type: 'object',
        properties: {
          channels: {
            type: 'array',
            items: { type: 'object', properties: { channelId: { type: 'string' }, name: { type: 'string' } } },
          },
        },
      },
    }),
    action({
      name: 'chat_post_message',
      method: 'POST',
      path: '/api/chat.postMessage',
      safety: 'write',
      paramsSchema: {
        type: 'object',
        required: ['body'],
        properties: {
          body: param('body', {
            type: 'object',
            required: ['channelId', 'text'],
            properties: { channelId: { type: 'string' }, text: { type: 'string' } },
          }),
        },
      },
    }),
  ];

  it('links a distinctive field name with no shared URL path', () => {
    const graph = computeLineage(record(RPC));
    const edges = producersFor(graph, 'chat_post_message', 'body.channelId');
    expect(edges.map((e) => e.from.tool)).toContain('conversations_list');
    expect(edges[0].why).toContain('distinctive_name');
  });

  it('leaves the free-text message body unproduced', () => {
    const graph = computeLineage(record(RPC));
    expect(producersFor(graph, 'chat_post_message', 'body.text')).toEqual([]);
  });
});

describe('computeLineage — signals and confidence', () => {
  it('records why every edge was emitted', () => {
    const graph = computeLineage(record(REST));
    for (const edge of graph.edges) {
      expect(edge.why.length).toBeGreaterThan(0);
      expect(edge.score).toBeGreaterThanOrEqual(20);
    }
  });

  it('promotes a title match', () => {
    const graph = computeLineage(
      record([
        action({
          name: 'get_a',
          method: 'GET',
          path: '/alpha',
          responseSchema: { type: 'object', properties: { ref: { type: 'string', title: 'AccountRef' } } },
        }),
        action({
          name: 'post_b',
          method: 'POST',
          path: '/beta',
          safety: 'write',
          paramsSchema: {
            type: 'object',
            properties: { body: param('body', { type: 'object', properties: { ref: { type: 'string', title: 'AccountRef' } } }) },
          },
        }),
      ]),
    );
    const edge = producersFor(graph, 'post_b', 'body.ref')[0];
    expect(edge.why).toContain('title_match');
    expect(edge.confidence).toBe('high');
  });

  it('penalizes a type mismatch', () => {
    const graph = computeLineage(
      record([
        action({
          name: 'get_x',
          method: 'GET',
          path: '/accounts',
          responseSchema: { type: 'object', properties: { accountRef: { type: 'boolean' } } },
        }),
        action({
          name: 'post_y',
          method: 'POST',
          path: '/accounts/transfer',
          safety: 'write',
          paramsSchema: {
            type: 'object',
            properties: { body: param('body', { type: 'object', properties: { accountRef: { type: 'string' } } }) },
          },
        }),
      ]),
    );
    const edge = producersFor(graph, 'post_y', 'body.accountRef')[0];
    if (edge) expect(edge.why).toContain('type_mismatch');
  });

  it('treats integer and number as compatible', () => {
    const graph = computeLineage(
      record([
        action({
          name: 'get_meter',
          method: 'GET',
          path: '/meters',
          responseSchema: { type: 'object', properties: { meterReading: { type: 'integer' } } },
        }),
        action({
          name: 'post_meter',
          method: 'POST',
          path: '/meters/report',
          safety: 'write',
          paramsSchema: {
            type: 'object',
            properties: { body: param('body', { type: 'object', properties: { meterReading: { type: 'number' } } }) },
          },
        }),
      ]),
    );
    expect(producersFor(graph, 'post_meter', 'body.meterReading')[0].why).toContain('type_match');
  });

  it('withholds low-confidence edges unless explicitly requested', () => {
    const actions = [
      action({
        name: 'get_alpha',
        method: 'GET',
        path: '/alpha',
        responseSchema: { type: 'object', properties: { sharedThing: { type: 'boolean' } } },
      }),
      action({
        name: 'post_beta',
        method: 'POST',
        path: '/beta',
        safety: 'write',
        paramsSchema: {
          type: 'object',
          properties: { body: param('body', { type: 'object', properties: { sharedThing: { type: 'string' } } }) },
        },
      }),
    ];
    const standard = computeLineage(record(actions));
    const withLow = computeLineage(record(actions), { includeLow: true });
    expect(withLow.edges.length).toBeGreaterThanOrEqual(standard.edges.length);
    expect(standard.edges.every((e) => e.confidence !== 'low')).toBe(true);
  });
});

describe('lineageFor — caching', () => {
  it('returns a cached graph for the same record', () => {
    const r = record(REST);
    expect(lineageFor(r)).toBe(lineageFor(r));
  });

  it('recomputes for a different record object', () => {
    expect(lineageFor(record(REST))).not.toBe(lineageFor(record(REST)));
  });

  // Regression: the cache was keyed on `id|actionCount|createdAt`, which two
  // different records can easily agree on — the collision returned a graph
  // computed from somebody else's actions. Silently wrong answers are the worst
  // failure this module can have, so identity is now the key.
  it('does not confuse two records that share id, length and timestamp', () => {
    const a: ImportRecord = { ...record(REST), id: 'same', createdAt: 1 };
    const b: ImportRecord = {
      ...record([
        action({
          name: 'list_customers',
          method: 'GET',
          path: '/v1/customers',
          responseSchema: { type: 'object', properties: { unrelated: { type: 'string' } } },
        }),
        action({ name: 'create_customer', method: 'POST', path: '/v1/customers', safety: 'write' }),
        action({ name: 'create_order', method: 'POST', path: '/v1/orders', safety: 'write' }),
      ]),
      id: 'same',
      createdAt: 1,
    };
    expect(a.id).toBe(b.id);
    expect(a.actions.length).toBe(b.actions.length);

    expect(lineageFor(a).edges.length).toBeGreaterThan(0);
    expect(lineageFor(b).edges).toEqual([]);
  });

  it('keys separately on the includeLow option', () => {
    const r = record(REST);
    expect(lineageFor(r)).not.toBe(lineageFor(r, { includeLow: true }));
  });
});

describe('findFieldsByName', () => {
  it('finds every field with a matching leaf name across the API', () => {
    const hits = findFieldsByName(record(REST), 'customerId');
    expect(hits.map((h) => h.tool)).toContain('create_order');
  });

  it('normalizes naming styles', () => {
    const snake = findFieldsByName(record(REST), 'customer_id');
    expect(snake.map((h) => h.tool)).toContain('create_order');
  });

  it('accepts a full path and ranks the exact match first', () => {
    const hits = findFieldsByName(record(REST), 'body.customerId');
    expect(hits[0]).toMatchObject({ tool: 'create_order' });
    expect(hits[0].field.path).toBe('body.customerId');
  });

  it('returns nothing for an unknown field', () => {
    expect(findFieldsByName(record(REST), 'no_such_field')).toEqual([]);
  });
});

describe('computeLineage — robustness', () => {
  it('handles an API with no schemas at all', () => {
    const graph = computeLineage(record([action({ name: 'ping', method: 'GET', path: '/ping' })]));
    expect(graph.edges).toEqual([]);
    expect(graph.stats.producerFields).toBe(0);
  });

  it('does not blow up on a large API', () => {
    const many: Action[] = [];
    for (let i = 0; i < 150; i++) {
      many.push(
        action({
          name: `list_res${i}`,
          method: 'GET',
          path: `/res${i}`,
          responseSchema: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } },
        }),
        action({
          name: `get_res${i}`,
          method: 'GET',
          path: `/res${i}/{res${i}Id}`,
          paramsSchema: { type: 'object', required: [`res${i}Id`], properties: { [`res${i}Id`]: param('path', { type: 'string' }) } },
        }),
      );
    }
    const started = Date.now();
    const graph = computeLineage(record(many));
    expect(Date.now() - started).toBeLessThan(5000);
    // Each resource links to its own list, and to nothing else.
    expect(graph.edges.length).toBeGreaterThan(0);
    for (const edge of graph.edges) {
      const fromIndex = edge.from.tool.replace('list_res', '');
      const toIndex = edge.to.tool.replace('get_res', '');
      expect(fromIndex).toBe(toIndex);
    }
  });
});
