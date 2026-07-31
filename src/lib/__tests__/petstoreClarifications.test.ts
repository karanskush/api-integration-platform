// End-to-end guard for the clarification loop, against the real Swagger Petstore
// (fixtures/petstore/openapi.json, spec version 1.0.27).
//
// This exists because the defects it covers were not visible from any unit test.
// Each component behaved correctly in isolation; the failure only appeared when a
// real spec went through the whole chain, and it appeared as a person being asked
// 22 questions, about half of which were unanswerable by anyone outside this
// codebase. So the assertions here are deliberately about the OUTPUT A HUMAN
// SEES, not about internal shapes.
//
// Runs the production path with no LLM, which is also the degraded path the
// enrich job takes when no AI Gateway key is configured.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { classifyQuestion } from '../clarify';
import { fieldMapFor } from '../fieldMap';
import { clusterQuestions, consideredFieldsFor, reconcileOpenQuestions, type OpenQuestion } from '../deepEnrich';
import { parseOpenApi } from '../importer/openapi';
import type { ImportRecord } from '../ir';
import { findFieldsByName, lineageFor, producersFor } from '../lineage';
import { normalizeOpenApi } from '../normalize';
import { curlSnippet } from '../snippets';
import { traceField } from '../advisor/fields';
import { emptyInsights } from '../advisor/types';

const SPEC_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/petstore/openapi.json');

// normalizeOpenApi returns a NormalizedSpec; the analysis chain works on the
// ImportRecord that runImport/loadRecordForVersion assemble around it. Wrapping
// it here is what runImport does with the same fields.
async function petstore(): Promise<ImportRecord> {
  const doc = await parseOpenApi(JSON.parse(readFileSync(SPEC_PATH, 'utf8')));
  const spec = normalizeOpenApi(doc, 'https://petstore3.swagger.io/api/v3/openapi.json');

  const counts = { total: spec.actions.length, read: 0, write: 0, destructive: 0 };
  for (const a of spec.actions) counts[a.safety]++;

  return {
    id: 'petstore-fixture',
    name: spec.name,
    source: 'openapi',
    sourceUrl: 'https://petstore3.swagger.io/api/v3/openapi.json',
    baseUrls: spec.rawBaseUrls,
    auth: spec.auth,
    ...(spec.authIn ? { authIn: spec.authIn } : {}),
    actions: spec.actions,
    truncated: spec.truncated,
    ...(spec.externalDocsUrl ? { externalDocsUrl: spec.externalDocsUrl } : {}),
    counts,
    createdAt: 1,
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
}

async function questionsFor(record: ImportRecord): Promise<OpenQuestion[]> {
  const actionPathByName = new Map(record.actions.map((a) => [a.name, a.path]));
  const considered = consideredFieldsFor(record, record.actions);
  const auto = reconcileOpenQuestions(
    considered,
    { fields: [], openQuestions: [], chunksProcessed: 0, chunksTotal: 0, truncated: false },
    actionPathByName,
  );
  return clusterQuestions(auto, actionPathByName);
}

describe('petstore lineage no longer conflates distinct entity ids', () => {
  // Pet, Category and Tag each declare a bare int64 `id`, and none declares a
  // schema title. Every one of these previously resolved to "pet" because the
  // entity came from the operation path, so a petId had three interchangeable
  // sources at high confidence.
  it('offers only a pet id as the source of a petId', async () => {
    const graph = lineageFor(await petstore());
    const producers = producersFor(graph, 'get_pet_by_id', 'path.petId');
    expect(producers.length).toBeGreaterThan(0);
    for (const p of producers) {
      expect(p.from.field, `${p.from.tool}.${p.from.field}`).not.toContain('category');
      expect(p.from.field, `${p.from.tool}.${p.from.field}`).not.toContain('tags');
    }
  });

  it('resolves nested category and tag ids to their own kind', async () => {
    const graph = lineageFor(await petstore());
    for (const p of producersFor(graph, 'update_pet', 'body.category.id')) {
      expect(p.from.field).toContain('category');
    }
    for (const p of producersFor(graph, 'update_pet', 'body.tags[].id')) {
      expect(p.from.field).toContain('tags');
    }
    for (const p of producersFor(graph, 'update_pet', 'body.id')) {
      expect(p.from.field).not.toMatch(/category|tags/);
    }
  });

  it('does not treat a read of a pet as the source of a new pet’s attributes', async () => {
    const graph = lineageFor(await petstore());
    // find_pets_by_status returns the Pet shape add_pet's own body declares, so
    // photoUrls[] and status both scored as producers of what you are about to send.
    expect(producersFor(graph, 'add_pet', 'body.photoUrls[]')).toEqual([]);
    expect(producersFor(graph, 'add_pet', 'body.status')).toEqual([]);
  });

  it('leaves a caller-chosen enum filter with no producer', async () => {
    // GET /pet/findByStatus?status= lists its own legal values; nothing produces it.
    const graph = lineageFor(await petstore());
    expect(producersFor(graph, 'find_pets_by_status', 'query.status')).toEqual([]);
  });
});

describe('the whole API is considered, not just the first slice of it', () => {
  // consideredFieldsFor takes a prompt budget, and reconciliation has no prompt.
  // Passing enrichRecord's per-chunk cap here silently cost reconciliation most
  // of the API: 40 of 64 writable fields and 12 of 19 operations, so every
  // user-facing operation was invisible to clarification. Nothing failed — the
  // questions simply were never considered.
  it('sees every writable field across every operation', async () => {
    const record = await petstore();
    const considered = consideredFieldsFor(record, record.actions);

    let writable = 0;
    for (const action of record.actions) {
      writable += fieldMapFor(action).request.filter((f) => !f.readOnly && !f.container).length;
    }

    expect(considered).toHaveLength(writable);
    expect(writable).toBeGreaterThan(40); // the cap that used to truncate this

    // Operations at the end of the spec are represented, not just the first few.
    const seen = new Set(considered.map((c) => c.action));
    for (const name of ['create_user', 'update_user', 'get_user_by_name']) {
      expect(seen.has(name), `${name} was not considered`).toBe(true);
    }
  });

  it('still honours an explicit budget when one is given', async () => {
    const record = await petstore();
    expect(consideredFieldsFor(record, record.actions, 10)).toHaveLength(10);
  });
});

describe('petstore request bodies are described accurately', () => {
  it('does not call the binary image upload a JSON body', async () => {
    const record = await petstore();
    const upload = record.actions.find((a) => a.name === 'upload_file');
    const body = (upload?.paramsSchema.properties as Record<string, Record<string, unknown>>).body;
    expect(body['x-docentapi-content-type']).toBe('application/octet-stream');
    expect(body.description).not.toBe('JSON request body');
  });
});

describe('the questions petstore actually raises', () => {
  it('asks about each field once, not once per operation', async () => {
    const record = await petstore();
    const questions = await questionsFor(record);
    const seen = new Set<string>();
    for (const q of questions) {
      const key = q.groupKey ?? `${q.tool} ${q.fieldPath}`;
      expect(seen.has(key), `duplicate question for ${key}`).toBe(false);
      seen.add(key);
    }
  });

  // The original run put 22 questions to a person. The exact number will move as
  // detectors change; the point of this bound is that a regression which
  // re-explodes it fails loudly rather than quietly shipping a wall of text.
  it('keeps the question count to something a person will actually finish', async () => {
    const questions = await questionsFor(await petstore());
    expect(questions.length).toBeGreaterThan(0);
    expect(questions.length).toBeLessThanOrEqual(16);
  });

  it('never asks the owner to adjudicate our own inference', async () => {
    const questions = await questionsFor(await petstore());
    for (const q of questions) {
      expect(q.question, q.question).not.toMatch(/knownProducers|heuristic|lineage|confidence score|scoring/i);
    }
  });

  it('gives every question a closed answer space rather than a blank box', async () => {
    const record = await petstore();
    const questions = await questionsFor(record);
    for (const q of questions) {
      const c = classifyQuestion(record, q);
      expect(c, `${q.tool} ${q.fieldPath} was not classified`).not.toBeNull();
      expect(c!.answerSpec.kind, `${q.tool} ${q.fieldPath}`).not.toBe('free_text');
      expect(c!.answerSpec.allowOther, `${q.tool} ${q.fieldPath}`).toBe(true);
    }
  });

  it('asks who assigns an order id, which is the one thing the spec cannot say', async () => {
    // Order.id is writable on POST /store/order and nothing declares whether the
    // server honours or overwrites it.
    const record = await petstore();
    const questions = await questionsFor(record);
    const orderId = questions.find((q) => q.tool === 'place_order' && q.fieldPath === 'body.id');
    expect(orderId).toBeDefined();
    expect(classifyQuestion(record, orderId!)?.archetype).toBe('identifier_ownership');
  });

  it('puts concrete questions before open-ended ones', async () => {
    const record = await petstore();
    const questions = await questionsFor(record);
    const ranks = questions.map((q) => classifyQuestion(record, q)?.rank ?? 99);
    // The classifier assigns the rank; the enrich job sorts on it. Assert the
    // ordering is available and meaningful rather than all-equal.
    expect(new Set(ranks).size).toBeGreaterThan(1);
  });
});

// The parameter table for PUT /pet lists category.name, and the cURL sample
// rendered directly beneath it did not send category at all. Two components,
// both individually "correct", disagreeing about the same operation on the same
// screen — which reads to a developer as "this endpoint does not really take
// that field".
describe('petstore snippets show the shape the parameter table promises', () => {
  it('sends the optional nested object the table lists, not just the required fields', async () => {
    const record = await petstore();
    const update = record.actions.find((a) => a.name === 'update_pet')!;
    const body = JSON.parse(curlSnippet(update, record).match(/-d '(.*)'$/s)![1]);

    expect(body.category).toEqual({ id: 1, name: 'Dogs' });
    expect(body.tags?.[0]).toHaveProperty('name');
    expect(body.status).toBe('available');
  });

  it('uses the examples the spec author wrote rather than discarding them', async () => {
    const record = await petstore();
    const add = record.actions.find((a) => a.name === 'add_pet')!;
    const body = JSON.parse(curlSnippet(add, record).match(/-d '(.*)'$/s)![1]);

    expect(body.name).toBe('doggie'); // Pet.name example
    expect(body.id).toBe(10); // Pet.id example
    expect(body.category.name).toBe('Dogs'); // Category.name example
  });

  it('fills an array with a sample item instead of emitting []', async () => {
    const record = await petstore();
    const add = record.actions.find((a) => a.name === 'add_pet')!;
    const body = JSON.parse(curlSnippet(add, record).match(/-d '(.*)'$/s)![1]);

    // photoUrls is required; `[]` satisfies the schema but shows a reader
    // nothing about what belongs in it.
    expect(body.photoUrls).toHaveLength(1);
    expect(typeof body.photoUrls[0]).toBe('string');
  });
});

describe('petstore field tracing distinguishes a nested field from its leaf name', () => {
  // "category.name" used to degrade into a search for any field named `name`,
  // so the first row returned was update_pet body.name — the PET's name. Every
  // answer built on that row was about the wrong field.
  it('resolves category.name to category.name and never to the bare name', async () => {
    const record = await petstore();
    const hits = findFieldsByName(record, 'category.name');

    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.field.path, `${hit.tool} ${hit.field.path}`).toContain('category.name');
    }
    expect(hits.some((h) => h.field.path === 'body.name')).toBe(false);
    expect(hits.some((h) => h.field.path.includes('tags[].name'))).toBe(false);
  });

  it('still finds a bare leaf name at any depth', async () => {
    const record = await petstore();
    const paths = findFieldsByName(record, 'name').map((h) => h.field.path);
    expect(paths).toContain('body.name');
    expect(paths).toContain('body.category.name');
    expect(paths).toContain('body.tags[].name');
  });

  // The defect this whole block exists for: trace_field reported category.name
  // as a value "not produced by any endpoint in this API" while it sits in five
  // response schemas. lineage.ts is right to refuse a FLOW edge for a generic
  // name like `name` — "call get_pet first to learn the category you are about
  // to send" is a wrong call sequence — but silence about the flow is not
  // licence to assert the field is never returned.
  it('reports where a caller-supplied value can actually be read', async () => {
    const record = await petstore();
    const res = traceField({ record, insights: emptyInsights() }, {
      field: 'category.name',
      tool: 'update_pet',
    }) as Record<string, unknown>;

    const results = res.results as Array<Record<string, unknown>>;
    const body = results.find((r) => r.field === 'body.category.name')!;
    expect(body).toBeDefined();

    // No producer edge — lineage's precision gate is unchanged.
    expect(body.producedBy).toEqual([]);
    expect(body.origin).toBe('caller_supplied');

    // ...but the operations that DO return it are named.
    const returned = (body.alsoReturnedBy as Array<{ tool: string }>).map((o) => o.tool);
    expect(returned).toContain('get_pet_by_id');
    expect(returned).toContain('find_pets_by_status');
    expect(body.guidance).toContain('alsoReturnedBy');

    // And the tool's own note must not tell a reader the opposite.
    expect(res.note).toContain('does NOT mean the field never appears in a response');
  });

  it('says nothing produces OR returns a value that genuinely has no source', async () => {
    const record = await petstore();
    // DELETE /pet/{petId}'s api_key header is the caller's own credential: no
    // petstore operation mints it and none returns it. The strong claim is
    // still available where it is actually true — the fix narrows it, it does
    // not remove it.
    const res = traceField({ record, insights: emptyInsights() }, { field: 'api_key' }) as Record<string, unknown>;
    const results = res.results as Array<Record<string, unknown>>;
    const key = results.find((r) => String(r.field).includes('api_key'))!;

    expect(key.origin).toBe('caller_supplied');
    expect(key.producedBy).toEqual([]);
    expect(key.alsoReturnedBy).toBeUndefined();
    expect(key.guidance).toContain('produces or returns');
  });
});
