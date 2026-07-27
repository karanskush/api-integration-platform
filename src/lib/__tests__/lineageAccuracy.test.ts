// Accuracy corpus for the lineage engine.
//
// Every other lineage test asks "does this specific rule work". This file asks
// the question BUILD_PLAN.md actually gates on: across a realistic API, what
// fraction of the edges the engine emits are correct? ">=95% edge accuracy...
// wrong call sequences are worse than no guidance" (BUILD_PLAN.md:197) is a
// precision requirement, not a recall one — a missing edge costs an agent a
// question; a wrong edge can make it act on the wrong resource.
//
// Each fixture below is a hand-built API shape with an accompanying hand-label
// of every edge a careful human would draw. Precision is computed against that
// label and asserted at 95%. Recall is reported, not gated — the design
// deliberately withholds ambiguous edges rather than guess, so recall is
// expected to be less than perfect and that is the intended tradeoff, not a
// defect to chase.
//
// Fixtures are hand-built rather than fetched from the real Stripe/GitHub/Slack
// specs: the importer already has dedicated conformance tests for real-world
// OpenAPI quirks (importer.test.ts), and network fetches have no place in a
// unit suite this repo runs offline. What these fixtures reproduce is the
// STRUCTURAL shape that makes each real API a distinct test of the engine:
// Stripe's deep nested objects and shared generic names, GitHub's pagination
// and REST resource nesting, Slack's RPC-style dotted paths with no URL
// resource hierarchy at all.

import { describe, expect, it } from 'vitest';
import { computeLineage, type LineageEdge } from '../lineage';
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

function param(where: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { 'x-spotcheck-in': where, ...extra };
}

function body(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return {
    type: 'object',
    required: ['body'],
    properties: { body: param('body', { type: 'object', properties, ...(required.length ? { required } : {}) }) },
  };
}

function record(actions: Action[]): ImportRecord {
  const counts = { total: actions.length, read: 0, write: 0, destructive: 0 };
  for (const a of actions) counts[a.safety]++;
  return {
    id: 'corpus',
    name: 'Corpus',
    source: 'openapi',
    baseUrls: ['https://api.corpus.test'],
    auth: 'bearer',
    actions,
    counts,
    createdAt: 1,
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
}

type ExpectedEdge = { from: string; to: string }; // "tool.field" -> "tool.field"

function edgeKey(e: { from: { tool: string; field: string }; to: { tool: string; field: string } }): string {
  return `${e.from.tool}.${e.from.field}->${e.to.tool}.${e.to.field}`;
}

type CorpusResult = {
  precision: number;
  recall: number;
  falsePositives: LineageEdge[];
  truePositiveCount: number;
  emittedCount: number;
  expectedCount: number;
};

// The actual gate: of what the engine claimed, how much was right. Recall is
// computed and returned for visibility but is never asserted on — see header.
function score(edges: LineageEdge[], expected: ExpectedEdge[]): CorpusResult {
  const expectedSet = new Set(expected.map((e) => `${e.from}->${e.to}`));
  const emittedSet = new Set(edges.map(edgeKey));

  const truePositives = edges.filter((e) => expectedSet.has(edgeKey(e)));
  const falsePositives = edges.filter((e) => !expectedSet.has(edgeKey(e)));
  const recalled = [...expectedSet].filter((k) => emittedSet.has(k));

  return {
    precision: edges.length ? truePositives.length / edges.length : 1,
    recall: expected.length ? recalled.length / expected.length : 1,
    falsePositives,
    truePositiveCount: truePositives.length,
    emittedCount: edges.length,
    expectedCount: expected.length,
  };
}

const PRECISION_GATE = 0.95;

function reportFalsePositives(label: string, result: CorpusResult) {
  if (result.falsePositives.length) {
    const detail = result.falsePositives.map((e) => `${edgeKey(e)} [${e.confidence}, ${e.why.join('+')}]`).join('; ');
    // eslint-disable-next-line no-console
    console.log(`[lineage accuracy] ${label} false positives: ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// Corpus 1: Petstore-shaped — simple REST, the baseline every engine should
// get right. Included as the floor case: if this doesn't hit ~100%, nothing
// else will.
// ---------------------------------------------------------------------------

function petstoreCorpus() {
  const actions = [
    action({
      name: 'list_pets',
      method: 'GET',
      path: '/pets',
      responseSchema: {
        type: 'array',
        items: { type: 'object', properties: { petId: { type: 'string' }, name: { type: 'string' } } },
      },
    }),
    action({
      name: 'create_pet',
      method: 'POST',
      path: '/pets',
      safety: 'write',
      paramsSchema: body({ name: { type: 'string' } }, ['name']),
      responseSchema: { type: 'object', properties: { petId: { type: 'string' } } },
    }),
    action({
      name: 'get_pet',
      method: 'GET',
      path: '/pets/{petId}',
      paramsSchema: { type: 'object', required: ['petId'], properties: { petId: param('path') } },
      responseSchema: { type: 'object', properties: { petId: { type: 'string' }, ownerId: { type: 'string' } } },
    }),
    action({
      name: 'list_owners',
      method: 'GET',
      path: '/owners',
      responseSchema: {
        type: 'array',
        items: { type: 'object', properties: { ownerId: { type: 'string' }, email: { type: 'string' } } },
      },
    }),
    action({
      name: 'transfer_pet',
      method: 'POST',
      path: '/pets/{petId}/transfer',
      safety: 'write',
      paramsSchema: {
        type: 'object',
        required: ['petId', 'body'],
        properties: {
          petId: param('path'),
          body: param('body', { type: 'object', required: ['ownerId'], properties: { ownerId: { type: 'string' } } }),
        },
      },
    }),
  ];

  const expected: ExpectedEdge[] = [
    { from: 'list_pets.response[].petId', to: 'get_pet.path.petId' },
    { from: 'create_pet.response.petId', to: 'get_pet.path.petId' },
    { from: 'list_pets.response[].petId', to: 'transfer_pet.path.petId' },
    { from: 'create_pet.response.petId', to: 'transfer_pet.path.petId' },
    // get_pet also documents petId in its own response — a real, if less
    // obviously useful, producer for a second petId-shaped consumer.
    { from: 'get_pet.response.petId', to: 'transfer_pet.path.petId' },
    { from: 'list_owners.response[].ownerId', to: 'transfer_pet.body.ownerId' },
    // get_pet's response also documents ownerId (the pet's current owner) —
    // an equally valid producer to list_owners for transfer_pet's body.
    { from: 'get_pet.response.ownerId', to: 'transfer_pet.body.ownerId' },
  ];

  return { actions, expected };
}

// ---------------------------------------------------------------------------
// Corpus 2: Slack-shaped RPC — every operation lives at `/api/verb.noun`, so
// there is no REST resource hierarchy at all. This is the structural test that
// the engine's name/title signals carry real weight rather than the path.
// ---------------------------------------------------------------------------

function slackCorpus() {
  const actions = [
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
      paramsSchema: body({ channelId: { type: 'string' }, text: { type: 'string' } }, ['channelId', 'text']),
      responseSchema: { type: 'object', properties: { messageTs: { type: 'string' } } },
    }),
    action({
      name: 'chat_delete',
      method: 'POST',
      path: '/api/chat.delete',
      safety: 'destructive',
      paramsSchema: body({ channelId: { type: 'string' }, messageTs: { type: 'string' } }, ['channelId', 'messageTs']),
    }),
    action({
      name: 'users_list',
      method: 'GET',
      path: '/api/users.list',
      responseSchema: {
        type: 'array',
        items: { type: 'object', properties: { userId: { type: 'string' }, email: { type: 'string' } } },
      },
    }),
    action({
      name: 'conversations_invite',
      method: 'POST',
      path: '/api/conversations.invite',
      safety: 'write',
      paramsSchema: body({ channelId: { type: 'string' }, userId: { type: 'string' } }, ['channelId', 'userId']),
    }),
  ];

  const expected: ExpectedEdge[] = [
    { from: 'conversations_list.response.channels[].channelId', to: 'chat_post_message.body.channelId' },
    { from: 'conversations_list.response.channels[].channelId', to: 'conversations_invite.body.channelId' },
    { from: 'users_list.response[].userId', to: 'conversations_invite.body.userId' },
    { from: 'chat_post_message.response.messageTs', to: 'chat_delete.body.messageTs' },
    { from: 'conversations_list.response.channels[].channelId', to: 'chat_delete.body.channelId' },
  ];

  return { actions, expected };
}

// ---------------------------------------------------------------------------
// Corpus 3: GitHub-shaped — nested REST resources, pagination parameters that
// must NOT be mistaken for lineage-worthy identifiers, and two resources
// (issues, pull requests) that both expose a bare `number` — a trap for a
// naive matcher.
// ---------------------------------------------------------------------------

function githubCorpus() {
  const actions = [
    action({
      name: 'list_repo_issues',
      method: 'GET',
      path: '/repos/{owner}/{repo}/issues',
      paramsSchema: {
        type: 'object',
        required: ['owner', 'repo'],
        properties: {
          owner: param('path'),
          repo: param('path'),
          page: param('query', { type: 'integer' }),
          per_page: param('query', { type: 'integer' }),
        },
      },
      responseSchema: {
        type: 'array',
        items: { type: 'object', properties: { number: { type: 'integer' }, title: { type: 'string' } } },
      },
    }),
    action({
      name: 'get_issue',
      method: 'GET',
      path: '/repos/{owner}/{repo}/issues/{issueNumber}',
      paramsSchema: {
        type: 'object',
        required: ['owner', 'repo', 'issueNumber'],
        properties: { owner: param('path'), repo: param('path'), issueNumber: param('path') },
      },
      responseSchema: { type: 'object', properties: { number: { type: 'integer' }, userId: { type: 'string' } } },
    }),
    action({
      name: 'list_pull_requests',
      method: 'GET',
      path: '/repos/{owner}/{repo}/pulls',
      paramsSchema: {
        type: 'object',
        required: ['owner', 'repo'],
        properties: { owner: param('path'), repo: param('path'), page: param('query', { type: 'integer' }) },
      },
      responseSchema: {
        type: 'array',
        items: { type: 'object', properties: { number: { type: 'integer' }, title: { type: 'string' } } },
      },
    }),
    action({
      name: 'merge_pull_request',
      method: 'POST',
      path: '/repos/{owner}/{repo}/pulls/{pullNumber}/merge',
      safety: 'write',
      paramsSchema: {
        type: 'object',
        required: ['owner', 'repo', 'pullNumber'],
        properties: { owner: param('path'), repo: param('path'), pullNumber: param('path') },
      },
    }),
    action({
      name: 'list_users',
      method: 'GET',
      path: '/users',
      paramsSchema: { type: 'object', properties: { since: param('query', { type: 'integer' }) } },
      responseSchema: { type: 'array', items: { type: 'object', properties: { userId: { type: 'string' }, login: { type: 'string' } } } },
    }),
    action({
      name: 'add_assignee',
      method: 'POST',
      path: '/repos/{owner}/{repo}/issues/{issueNumber}/assignees',
      safety: 'write',
      paramsSchema: {
        type: 'object',
        required: ['owner', 'repo', 'issueNumber', 'body'],
        properties: {
          owner: param('path'),
          repo: param('path'),
          issueNumber: param('path'),
          body: param('body', { type: 'object', required: ['userId'], properties: { userId: { type: 'string' } } }),
        },
      },
    }),
  ];

  const expected: ExpectedEdge[] = [
    { from: 'list_repo_issues.response[].number', to: 'get_issue.path.issueNumber' },
    { from: 'list_pull_requests.response[].number', to: 'merge_pull_request.path.pullNumber' },
    { from: 'list_users.response[].userId', to: 'add_assignee.body.userId' },
    { from: 'get_issue.response.userId', to: 'add_assignee.body.userId' },
    // NOT expected: get_issue.response.number -> merge_pull_request.path.pullNumber.
    // Both "issue" and "pull request" are numbered independently by GitHub; an
    // issue's number must never be offered as a pull request identifier, even
    // though both fields are literally named `number`. The corpus's precision
    // assertion is what actually enforces this — it's a trap, not a target.
  ];

  return { actions, expected };
}

// ---------------------------------------------------------------------------
// Corpus 4: Stripe-shaped — deep nested request bodies, an object type system
// via `object`/`title`-like discriminators, and several resources that all
// expose a bare `id`, which is exactly what the generic-name stoplist exists
// for.
// ---------------------------------------------------------------------------

function stripeCorpus() {
  const actions = [
    action({
      name: 'list_customers',
      method: 'GET',
      path: '/v1/customers',
      paramsSchema: { type: 'object', properties: { limit: param('query', { type: 'integer' }), starting_after: param('query', { type: 'string' }) } },
      responseSchema: {
        type: 'object',
        properties: {
          data: {
            type: 'array',
            items: { type: 'object', title: 'Customer', properties: { id: { type: 'string' }, email: { type: 'string' } } },
          },
          has_more: { type: 'boolean' },
        },
      },
    }),
    action({
      name: 'create_charge',
      method: 'POST',
      path: '/v1/charges',
      safety: 'write',
      paramsSchema: body(
        {
          customer: { type: 'string', title: 'CustomerId' },
          amount: { type: 'integer' },
          currency: { type: 'string', enum: ['usd', 'eur'] },
          source: {
            type: 'object',
            properties: { id: { type: 'string', title: 'PaymentSourceId' } },
          },
        },
        ['customer', 'amount', 'currency'],
      ),
      responseSchema: { type: 'object', title: 'Charge', properties: { id: { type: 'string' }, customer: { type: 'string' } } },
    }),
    action({
      name: 'list_payment_sources',
      method: 'GET',
      path: '/v1/customers/{customer}/sources',
      paramsSchema: { type: 'object', required: ['customer'], properties: { customer: param('path') } },
      responseSchema: {
        type: 'object',
        properties: {
          data: { type: 'array', items: { type: 'object', properties: { id: { type: 'string', title: 'PaymentSourceId' } } } },
        },
      },
    }),
    action({
      name: 'create_refund',
      method: 'POST',
      path: '/v1/refunds',
      safety: 'write',
      paramsSchema: body({ charge: { type: 'string', title: 'ChargeId' }, amount: { type: 'integer' } }, ['charge']),
      responseSchema: { type: 'object', title: 'Refund', properties: { id: { type: 'string' }, charge: { type: 'string' } } },
    }),
    action({
      name: 'list_invoices',
      method: 'GET',
      path: '/v1/invoices',
      responseSchema: {
        type: 'object',
        properties: {
          data: { type: 'array', items: { type: 'object', title: 'Invoice', properties: { id: { type: 'string' }, customer: { type: 'string' } } } },
        },
      },
    }),
  ];

  const expected: ExpectedEdge[] = [
    { from: 'list_customers.response.data[].id', to: 'create_charge.body.customer' },
    { from: 'list_customers.response.data[].id', to: 'list_payment_sources.path.customer' },
    { from: 'list_payment_sources.response.data[].id', to: 'create_charge.body.source.id' },
    { from: 'create_charge.response.id', to: 'create_refund.body.charge' },
    // Real Stripe objects echo the customer id on more than just the Customer
    // object itself — an Invoice's `customer` field and a Charge response's
    // `customer` field are both legitimate, independently-correct producers
    // for anything that consumes a customer id.
    { from: 'list_invoices.response.data[].customer', to: 'create_charge.body.customer' },
    { from: 'list_invoices.response.data[].customer', to: 'list_payment_sources.path.customer' },
    { from: 'create_charge.response.customer', to: 'list_payment_sources.path.customer' },
    // NOT expected: create_charge.response.id -> create_refund.response.id, or
    // any edge between two bare `id` fields on unrelated resources (Customer,
    // Charge, PaymentSource, Refund, Invoice all expose one). The
    // title-carried type identity is what is supposed to keep these apart.
  ];

  return { actions, expected };
}

describe('lineage accuracy corpus', () => {
  it('Petstore (baseline REST) meets the precision gate', () => {
    const { actions, expected } = petstoreCorpus();
    const graph = computeLineage(record(actions));
    const result = score(graph.edges, expected);
    reportFalsePositives('petstore', result);
    expect(result.precision).toBeGreaterThanOrEqual(PRECISION_GATE);
    expect(result.truePositiveCount).toBeGreaterThan(0);
  });

  it('Slack (RPC, no URL resource hierarchy) meets the precision gate', () => {
    const { actions, expected } = slackCorpus();
    const graph = computeLineage(record(actions));
    const result = score(graph.edges, expected);
    reportFalsePositives('slack', result);
    expect(result.precision).toBeGreaterThanOrEqual(PRECISION_GATE);
    // The point of this corpus: recall has to come from name/title matching
    // alone, since there is no shared path structure to fall back on.
    expect(result.recall).toBeGreaterThan(0.5);
  });

  it('GitHub (pagination + a numbering trap) meets the precision gate', () => {
    const { actions, expected } = githubCorpus();
    const graph = computeLineage(record(actions));
    const result = score(graph.edges, expected);
    reportFalsePositives('github', result);
    expect(result.precision).toBeGreaterThanOrEqual(PRECISION_GATE);

    // Pagination parameters must never be treated as lineage targets.
    expect(graph.edges.some((e) => e.to.field.includes('page') || e.to.field.includes('per_page'))).toBe(false);
    // The specific trap: an issue number must never be offered for a pull
    // request identifier merely because both fields are named `number`.
    expect(
      graph.edges.some((e) => e.from.tool === 'get_issue' && e.to.tool === 'merge_pull_request'),
    ).toBe(false);
  });

  it('Stripe (deep nesting, shared bare ids across five resources) meets the precision gate', () => {
    const { actions, expected } = stripeCorpus();
    const graph = computeLineage(record(actions));
    const result = score(graph.edges, expected);
    reportFalsePositives('stripe', result);
    expect(result.precision).toBeGreaterThanOrEqual(PRECISION_GATE);

    // The specific trap: five resources share a bare `id` field. None of them
    // should cross-link on that name alone.
    const crossResourceIdLinks = graph.edges.filter(
      (e) => e.from.field.endsWith('.id') && e.to.field.endsWith('.id') && e.why.length === 1 && e.why[0] === 'generic_name',
    );
    expect(crossResourceIdLinks).toEqual([]);
  });

  it('reports aggregate precision and recall across the whole corpus', () => {
    const corpora = [petstoreCorpus(), slackCorpus(), githubCorpus(), stripeCorpus()];
    let edgesTotal = 0;
    let expectedTotal = 0;
    let truePositivesTotal = 0;
    let falsePositivesTotal = 0;

    for (const { actions, expected } of corpora) {
      const graph = computeLineage(record(actions));
      const result = score(graph.edges, expected);
      edgesTotal += result.emittedCount;
      expectedTotal += result.expectedCount;
      truePositivesTotal += result.truePositiveCount;
      falsePositivesTotal += result.falsePositives.length;
    }

    const aggregatePrecision = edgesTotal ? truePositivesTotal / edgesTotal : 1;
    const aggregateRecall = expectedTotal ? truePositivesTotal / expectedTotal : 1;

    // eslint-disable-next-line no-console
    console.log(
      `[lineage accuracy] aggregate: precision=${aggregatePrecision.toFixed(3)} recall=${aggregateRecall.toFixed(3)} ` +
        `(${truePositivesTotal} correct / ${edgesTotal} emitted / ${expectedTotal} expected, ${falsePositivesTotal} false positives)`,
    );

    // The gate from BUILD_PLAN.md:197. Recall is logged for visibility only —
    // asserting on it would pressure the engine toward guessing, which is
    // exactly what the design refuses to do.
    expect(aggregatePrecision).toBeGreaterThanOrEqual(PRECISION_GATE);
  });
});
