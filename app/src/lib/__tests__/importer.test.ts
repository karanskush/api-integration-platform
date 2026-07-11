import { describe, expect, it } from 'vitest';
import { detectInput, DetectError } from '../importer/detect';
import { parseCurl, curlToOpenApi, tokenize, CurlParseError } from '../importer/curl';
import { parseOpenApi } from '../importer/openapi';
import { normalizeOpenApi, snakeCase, classifySafety } from '../normalize';

const PETSTORE_MINI = {
  openapi: '3.0.3',
  info: { title: 'Mini Petstore', version: '1.0.0' },
  servers: [{ url: 'https://petstore.example.com/v3' }, { url: 'http://10.0.0.5/internal' }],
  components: {
    securitySchemes: {
      api_key: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
    },
    schemas: {
      Pet: {
        type: 'object',
        required: ['name'],
        properties: {
          id: { type: 'integer', format: 'int64' },
          name: { type: 'string', example: 'doggie' },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
  security: [{ api_key: [] }],
  paths: {
    '/pets/{petId}': {
      parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'integer' } }],
      get: {
        operationId: 'getPetById',
        summary: 'Find pet by ID',
        parameters: [{ name: 'verbose', in: 'query', schema: { type: 'boolean' } }],
        responses: { '200': { description: 'ok' } },
      },
      delete: {
        operationId: 'deletePet',
        responses: { '204': { description: 'gone' } },
      },
    },
    '/pets': {
      post: {
        operationId: 'addPet',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } },
        },
        responses: { '200': { description: 'ok' } },
      },
    },
  },
};

describe('detectInput', () => {
  it('detects curl', () => {
    expect(detectInput("curl https://api.example.com/x").kind).toBe('curl');
  });
  it('detects openapi json', () => {
    expect(detectInput(JSON.stringify(PETSTORE_MINI)).kind).toBe('openapi');
  });
  it('detects swagger yaml', () => {
    expect(detectInput('swagger: "2.0"\ninfo:\n  title: x\n  version: "1"\npaths: {}').kind).toBe('swagger');
  });
  it('detects postman', () => {
    const col = {
      info: { _postman_id: 'abc', name: 'x', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [],
    };
    expect(detectInput(JSON.stringify(col)).kind).toBe('postman');
  });
  it('rejects garbage', () => {
    expect(() => detectInput('hello world :: not a spec')).toThrow(DetectError);
  });
});

describe('normalizeOpenApi', () => {
  it('normalizes the mini petstore', async () => {
    const doc = await parseOpenApi(structuredClone(PETSTORE_MINI) as never);
    const spec = normalizeOpenApi(doc);

    expect(spec.name).toBe('Mini Petstore');
    // both servers survive normalization; SSRF filtering happens in runImport
    expect(spec.rawBaseUrls).toContain('https://petstore.example.com/v3');
    expect(spec.auth).toBe('apiKey');
    expect(spec.authIn).toEqual({ in: 'header', name: 'X-Api-Key' });
    expect(spec.actions).toHaveLength(3);

    const get = spec.actions.find((a) => a.name === 'get_pet_by_id')!;
    expect(get.method).toBe('GET');
    expect(get.safety).toBe('read');
    const props = get.paramsSchema.properties as Record<string, Record<string, unknown>>;
    expect(props.petId['x-spotcheck-in']).toBe('path');
    expect(props.verbose['x-spotcheck-in']).toBe('query');
    expect(get.paramsSchema.required).toEqual(['petId']);

    const del = spec.actions.find((a) => a.name === 'delete_pet')!;
    expect(del.safety).toBe('destructive');

    const add = spec.actions.find((a) => a.name === 'add_pet')!;
    expect(add.safety).toBe('write');
    const bodySchema = (add.paramsSchema.properties as Record<string, Record<string, unknown>>).body;
    expect(bodySchema['x-spotcheck-in']).toBe('body');
    // $ref was dereferenced into the real Pet schema
    expect((bodySchema.properties as Record<string, unknown>).name).toBeDefined();
    expect(add.paramsSchema.required).toEqual(['body']);
  });
});

describe('snakeCase / safety', () => {
  it('converts names', () => {
    expect(snakeCase('getPetById')).toBe('get_pet_by_id');
    expect(snakeCase('List Payment-Intents')).toBe('list_payment_intents');
  });
  it('classifies destructive by name', () => {
    expect(classifySafety('post', 'cancel_payment', '/v1/payments/cancel')).toBe('destructive');
    expect(classifySafety('post', 'create_payment', '/v1/payments')).toBe('write');
    expect(classifySafety('get', 'anything', '/x')).toBe('read');
  });
});

describe('curl parsing', () => {
  it('tokenizes quoted strings', () => {
    expect(tokenize(`curl -H 'X-A: b c' "https://e.com/p?q=1"`)).toEqual([
      'curl', '-H', 'X-A: b c', 'https://e.com/p?q=1',
    ]);
  });
  it('handles line continuations', () => {
    expect(tokenize("curl \\\n  -X POST \\\n  https://e.com")).toEqual(['curl', '-X', 'POST', 'https://e.com']);
  });
  it('parses a realistic command', () => {
    const req = parseCurl(
      `curl 'https://api.stripe.com/v1/charges?limit=3' -u sk_test_123: -H 'Stripe-Version: 2026-01-01'`,
    );
    expect(req.method).toBe('GET');
    expect(req.url.hostname).toBe('api.stripe.com');
    expect(req.basicAuth).toBe('sk_test_123:');
    expect(req.headers['Stripe-Version']).toBe('2026-01-01');
  });
  it('infers POST + json body schema', () => {
    const doc = curlToOpenApi(
      `curl https://api.example.com/v1/users -H 'Authorization: Bearer tok' -d '{"name":"kasi","age":30}'`,
    );
    const paths = doc.paths as Record<string, Record<string, Record<string, unknown>>>;
    const op = paths['/v1/users'].post;
    expect(op).toBeDefined();
    const rb = op.requestBody as Record<string, never>;
    expect(rb).toBeDefined();
    const schemes = (doc.components as Record<string, Record<string, unknown>>).securitySchemes;
    expect(schemes.detected).toEqual({ type: 'http', scheme: 'bearer' });
  });
  it('rejects unsupported flags loudly', () => {
    expect(() => parseCurl('curl --proxy http://x https://e.com')).toThrow(CurlParseError);
    expect(() => parseCurl('curl -d @file.json https://e.com')).toThrow(CurlParseError);
  });
});
