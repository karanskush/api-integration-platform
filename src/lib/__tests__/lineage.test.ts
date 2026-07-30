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
  return { 'x-docentapi-in': where, ...extra };
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
  // Found by driving the real Swagger Petstore over MCP (fields.ts's own
  // describe_fields, not a synthetic fixture): place_order's body and
  // get_order_by_id's response are the SAME Order shape, and quantity/
  // shipDate/complete were traced as "produced by" get_order_by_id with high
  // confidence. That is backwards — get_order_by_id needs an orderId that
  // only exists once place_order has already run, so it cannot be an upstream
  // source for place_order's own body. It is an echo, not a flow.
  it('does not treat a GET-by-id on the resource being created as a producer for that create', () => {
    const graph = computeLineage(
      record([
        action({
          name: 'place_order',
          method: 'POST',
          path: '/store/order',
          safety: 'write',
          paramsSchema: {
            type: 'object',
            properties: {
              body: param('body', {
                type: 'object',
                properties: {
                  quantity: { type: 'integer' },
                  shipDate: { type: 'string', format: 'date-time' },
                  complete: { type: 'boolean' },
                },
              }),
            },
          },
        }),
        action({
          name: 'get_order_by_id',
          method: 'GET',
          path: '/store/order/{orderId}',
          paramsSchema: { type: 'object', required: ['orderId'], properties: { orderId: param('path') } },
          responseSchema: {
            type: 'object',
            properties: {
              quantity: { type: 'integer' },
              shipDate: { type: 'string', format: 'date-time' },
              complete: { type: 'boolean' },
            },
          },
        }),
      ]),
    );

    expect(producersFor(graph, 'place_order', 'body.quantity')).toEqual([]);
    expect(producersFor(graph, 'place_order', 'body.shipDate')).toEqual([]);
    expect(producersFor(graph, 'place_order', 'body.complete')).toEqual([]);
  });

  // The scope of the fix: an UPDATE (not a create) legitimately read-modifies
  // a resource that already exists, so a prior GET of it is a normal and
  // correct pattern — this must keep working.
  it('still allows a GET-by-id to producer an UPDATE (not create) on the same resource', () => {
    const graph = computeLineage(
      record([
        action({
          name: 'get_order_by_id',
          method: 'GET',
          path: '/store/order/{orderId}',
          paramsSchema: { type: 'object', required: ['orderId'], properties: { orderId: param('path') } },
          responseSchema: { type: 'object', properties: { trackingCode: { type: 'string' } } },
        }),
        action({
          name: 'update_order',
          method: 'PUT',
          path: '/store/order/{orderId}',
          safety: 'write',
          paramsSchema: {
            type: 'object',
            required: ['orderId', 'body'],
            properties: {
              orderId: param('path'),
              body: param('body', { type: 'object', properties: { trackingCode: { type: 'string' } } }),
            },
          },
        }),
      ]),
    );
    expect(producersFor(graph, 'update_order', 'body.trackingCode').map((e) => e.from.tool)).toContain('get_order_by_id');
  });


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

  // Found by the accuracy corpus (lineageAccuracy.test.ts): a purely generic,
  // non-identifier field shared by two operations on the same resource is NOT
  // evidence of data flow — list_pets.name and create_pet.name are two
  // independent pieces of data, not one flowing into the other. Resource
  // affinity alone (plus the type_match/collection_producer bonuses that used
  // to stack on top of it automatically) was enough to promote this to medium
  // confidence, which is exactly the "wrong edge" class this module exists to
  // refuse. Only an id-LIKE generic name (a bare `id`) gets resource affinity
  // promoted at all — see scoreGenericMatch.
  it('does not link a non-identifier generic field shared by the same resource', () => {
    const graph = computeLineage(
      record([
        action({
          name: 'list_pets',
          method: 'GET',
          path: '/pets',
          responseSchema: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } } } },
        }),
        action({
          name: 'create_pet',
          method: 'POST',
          path: '/pets',
          safety: 'write',
          paramsSchema: {
            type: 'object',
            properties: { body: param('body', { type: 'object', properties: { name: { type: 'string' } } }) },
          },
        }),
      ]),
    );
    expect(producersFor(graph, 'create_pet', 'body.name')).toEqual([]);
  });

  // The one generic-name case that SHOULD still promote on resource affinity
  // alone: a bare `id`, which — unlike `name` or `status` — genuinely is an
  // identifier when the spec happens to name it that plainly rather than
  // `petId`.
  it('still links a bare id shared by the same resource', () => {
    const graph = computeLineage(
      record([
        action({
          name: 'list_pets',
          method: 'GET',
          path: '/pets',
          responseSchema: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } },
        }),
        action({
          name: 'get_pet',
          method: 'GET',
          path: '/pets/{id}',
          paramsSchema: { type: 'object', required: ['id'], properties: { id: param('path') } },
        }),
      ]),
    );
    expect(producersFor(graph, 'get_pet', 'path.id').map((e) => e.from.tool)).toContain('list_pets');
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

// The real Swagger Petstore, reduced to the shape that broke: Pet, Category and
// Tag each declare a bare int64 `id`, and NONE of them declares a schema title.
// Dereferencing inlines the $refs, so by the time lineage sees these fields the
// only thing distinguishing a Category id from a Pet id is the field's own path.
describe('lineage across nested entities that share an id field name', () => {
  const PET_SCHEMA = {
    type: 'object',
    properties: {
      id: { type: 'integer', format: 'int64' },
      name: { type: 'string' },
      category: { type: 'object', properties: { id: { type: 'integer', format: 'int64' }, name: { type: 'string' } } },
      tags: {
        type: 'array',
        items: { type: 'object', properties: { id: { type: 'integer', format: 'int64' }, name: { type: 'string' } } },
      },
      photoUrls: { type: 'array', items: { type: 'string' } },
      status: { type: 'string', enum: ['available', 'pending', 'sold'] },
    },
  };

  const PETSTORE = [
    action({
      name: 'add_pet',
      method: 'POST',
      path: '/pet',
      safety: 'write',
      paramsSchema: { type: 'object', required: ['body'], properties: { body: { ...PET_SCHEMA, 'x-docentapi-in': 'body' } } },
      responseSchema: PET_SCHEMA,
    }),
    action({
      name: 'update_pet',
      method: 'PUT',
      path: '/pet',
      safety: 'write',
      paramsSchema: { type: 'object', required: ['body'], properties: { body: { ...PET_SCHEMA, 'x-docentapi-in': 'body' } } },
      responseSchema: PET_SCHEMA,
    }),
    action({
      name: 'get_pet_by_id',
      method: 'GET',
      path: '/pet/{petId}',
      paramsSchema: {
        type: 'object',
        required: ['petId'],
        properties: { petId: param('path', { type: 'integer', format: 'int64' }) },
      },
      responseSchema: PET_SCHEMA,
    }),
    action({
      name: 'delete_pet',
      method: 'DELETE',
      path: '/pet/{petId}',
      safety: 'destructive',
      paramsSchema: {
        type: 'object',
        required: ['petId'],
        properties: { petId: param('path', { type: 'integer', format: 'int64' }) },
      },
    }),
  ];

  it('does not offer a tag or category id as the source of a petId', () => {
    const graph = computeLineage(record(PETSTORE));
    const producers = producersFor(graph, 'get_pet_by_id', 'path.petId');

    expect(producers.length).toBeGreaterThan(0); // the real edge still exists
    for (const edge of producers) {
      expect(edge.from.field).not.toContain('category');
      expect(edge.from.field).not.toContain('tags');
    }
    // Every surviving producer is a pet's own id, at the top of the response.
    expect(new Set(producers.map((e) => e.from.field))).toEqual(new Set(['response.id']));
  });

  it('keeps petId traceable from the create, at high confidence', () => {
    const graph = computeLineage(record(PETSTORE));
    const fromAdd = producersFor(graph, 'get_pet_by_id', 'path.petId').find((e) => e.from.tool === 'add_pet');
    expect(fromAdd).toBeDefined();
    expect(fromAdd!.from.field).toBe('response.id');
    expect(fromAdd!.confidence).toBe('high');
  });

  it('resolves a nested category id to a category producer, not the pet root', () => {
    const graph = computeLineage(record(PETSTORE));
    const producers = producersFor(graph, 'update_pet', 'body.category.id');
    for (const edge of producers) {
      expect(edge.from.field).toContain('category');
    }
  });

  it('resolves a nested tag id to a tag producer, not the pet root or a category', () => {
    const graph = computeLineage(record(PETSTORE));
    const producers = producersFor(graph, 'update_pet', 'body.tags[].id');
    for (const edge of producers) {
      expect(edge.from.field).toContain('tags');
      expect(edge.from.field).not.toContain('category');
    }
  });

  it("does not offer a nested entity's id as the source of the pet's own id", () => {
    const graph = computeLineage(record(PETSTORE));
    for (const edge of producersFor(graph, 'update_pet', 'body.id')) {
      expect(edge.from.field).not.toContain('category');
      expect(edge.from.field).not.toContain('tags');
    }
  });

  // A list read of the same collection a POST creates into returns the very
  // shape that POST's body declares. Every attribute lines up perfectly, which
  // is exactly why it scored HIGH — and exactly why it is a mirror, not a source.
  describe('echoes of the entity being created', () => {
    const WITH_LIST = [
      ...PETSTORE,
      action({
        name: 'find_pets_by_status',
        method: 'GET',
        path: '/pet/findByStatus',
        paramsSchema: {
          type: 'object',
          required: ['status'],
          properties: { status: param('query', { type: 'string', enum: ['available', 'pending', 'sold'] }) },
        },
        responseSchema: { type: 'array', items: PET_SCHEMA },
      }),
      action({
        name: 'place_order',
        method: 'POST',
        path: '/store/order',
        safety: 'write',
        paramsSchema: {
          type: 'object',
          required: ['body'],
          properties: {
            body: {
              'x-docentapi-in': 'body',
              type: 'object',
              properties: { id: { type: 'integer', format: 'int64' }, petId: { type: 'integer', format: 'int64' }, quantity: { type: 'integer' } },
            },
          },
        },
      }),
    ];

    it('does not treat a list read as the source of a created entity attribute', () => {
      const graph = computeLineage(record(WITH_LIST));
      expect(producersFor(graph, 'add_pet', 'body.photoUrls[]')).toEqual([]);
    });

    it('does not treat an update as the source either', () => {
      // A PUT returning the same Pet is as much a mirror as a GET: you cannot
      // update a pet that does not exist yet to learn its creation values.
      const graph = computeLineage(record(WITH_LIST));
      const fromUpdate = producersFor(graph, 'add_pet', 'body.photoUrls[]').filter((e) => e.from.tool === 'update_pet');
      expect(fromUpdate).toEqual([]);
    });

    it('keeps the list -> create foreign-key flow, which is the common correct case', () => {
      const graph = computeLineage(record(WITH_LIST));
      const producers = producersFor(graph, 'place_order', 'body.petId');
      expect(producers.length).toBeGreaterThan(0);
      expect(producers.every((e) => e.from.field.endsWith('id'))).toBe(true);
    });

    it('still lets an update read-modify-write the entity it updates', () => {
      // A PUT legitimately reads the current value first, so the echo guard is
      // scoped to POST consumers and must not touch this.
      const graph = computeLineage(record(WITH_LIST));
      expect(producersFor(graph, 'update_pet', 'body.photoUrls[]').length).toBeGreaterThan(0);
    });
  });

  // Petstore's GET /pet/findByStatus?status= declares its own enum. The legal
  // values are printed in the spec, so nothing "produces" it — but it shared the
  // name and the vocabulary with add_pet.response.status and picked up an
  // enum-overlap edge, which made describe_fields tell an agent to call add_pet
  // first to learn a value it could already read off the enum.
  describe('caller-chosen enum filters', () => {
    const filterAction = (where: 'query' | 'header', method: string) =>
      action({
        name: `find_by_${where}_${method.toLowerCase()}`,
        method,
        path: '/pet/findByStatus',
        paramsSchema: {
          type: 'object',
          required: ['status'],
          properties: { status: param(where, { type: 'string', enum: ['available', 'pending', 'sold'] }) },
        },
      });

    it('has no producer for an enum query filter on a read', () => {
      const graph = computeLineage(record([...PETSTORE, filterAction('query', 'GET')]));
      expect(producersFor(graph, 'find_by_query_get', 'query.status')).toEqual([]);
    });

    it('has no producer for an enum header filter on a read', () => {
      const graph = computeLineage(record([...PETSTORE, filterAction('header', 'GET')]));
      expect(producersFor(graph, 'find_by_header_get', 'header.status')).toEqual([]);
    });

    it('still traces the same enum in a request body, which a prior call can supply', () => {
      const graph = computeLineage(
        record([
          ...PETSTORE,
          action({
            name: 'set_pet_status',
            method: 'POST',
            path: '/pet/status',
            safety: 'write',
            paramsSchema: {
              type: 'object',
              required: ['body'],
              properties: {
                body: {
                  'x-docentapi-in': 'body',
                  type: 'object',
                  properties: { status: { type: 'string', enum: ['available', 'pending', 'sold'] } },
                },
              },
            },
          }),
        ]),
      );
      expect(producersFor(graph, 'set_pet_status', 'body.status').length).toBeGreaterThan(0);
    });

    it('still traces a query filter that carries no enum of its own', () => {
      const graph = computeLineage(
        record([
          ...PETSTORE,
          action({
            name: 'find_pets_by_owner',
            method: 'GET',
            path: '/pet/findByOwner',
            paramsSchema: {
              type: 'object',
              required: ['petId'],
              properties: { petId: param('query', { type: 'integer', format: 'int64' }) },
            },
          }),
        ]),
      );
      expect(producersFor(graph, 'find_pets_by_owner', 'query.petId').length).toBeGreaterThan(0);
    });
  });

  it('still refuses to link two genuinely unrelated resources by a bare id', () => {
    const graph = computeLineage(
      record([
        ...PETSTORE,
        action({
          name: 'get_store_inventory',
          method: 'GET',
          path: '/store/inventory',
          responseSchema: { type: 'object', properties: { id: { type: 'integer', format: 'int64' } } },
        }),
      ]),
    );
    expect(edgeLabels(graph).filter((l) => l.startsWith('get_store_inventory.'))).toEqual([]);
  });
});
