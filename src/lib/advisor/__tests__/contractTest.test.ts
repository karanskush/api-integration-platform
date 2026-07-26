import { describe, expect, it } from 'vitest';
import { generateContractTest as rawGenerateContractTest } from '../contractTest';
import type { AdvisorContext } from '../types';
import { action, ctx, param, petstoreActions, type Payload } from './fixtures';

const generateContractTest = (c: AdvisorContext, a: Record<string, unknown>): Payload =>
  rawGenerateContractTest(c, a);

const context = ctx(petstoreActions());

describe('generateContractTest', () => {
  it('requires a known tool', () => {
    expect(generateContractTest(context, {}).error).toContain('tool is required');
    expect(generateContractTest(context, { tool: 'nope' }).error).toContain('No operation named');
  });

  it('emits TypeScript by default with a matching filename', () => {
    const res = generateContractTest(context, { tool: 'get_pet' });
    expect(res.language).toBe('typescript');
    expect(res.filename).toBe('get_pet.contract.test.ts');
    expect(res.source).toContain("import { test } from 'node:test'");
    expect(res.source).toContain("import assert from 'node:assert/strict'");
  });

  it('asserts the status class', () => {
    const res = generateContractTest(context, { tool: 'get_pet' });
    expect(res.source).toContain('assert.ok(res.ok');
    expect(res.asserts?.statusClass).toBe(true);
  });

  it('asserts the content type and each documented required field', () => {
    const res = generateContractTest(context, { tool: 'get_pet' });
    expect(res.source).toMatch(/content-type/);
    expect(res.asserts?.documentedFields).toEqual(['id', 'name']);
    expect(res.source).toContain('sample?.id !== undefined');
    expect(res.source).toContain('sample?.name !== undefined');
  });

  it('unwraps an array response before asserting on item fields', () => {
    const res = generateContractTest(context, { tool: 'list_pets' });
    expect(res.source).toContain('Array.isArray(body)');
    expect(res.asserts?.documentedFields).toEqual(['id', 'name']);
  });

  it('states the limitation when the spec documents no response shape', () => {
    const res = generateContractTest(context, { tool: 'update_pet' });
    expect(res.asserts?.documentedFields).toEqual([]);
    expect(res.limitation).toContain('only assert the status class');
    expect(res.asserts?.contentType).toBe(false);
  });

  it('warns before putting a write against a real environment in CI', () => {
    expect(generateContractTest(context, { tool: 'create_pet' }).warning).toContain('sandbox');
    expect(generateContractTest(context, { tool: 'delete_pet' }).warning).toContain('destructive');
    expect(generateContractTest(context, { tool: 'get_pet' }).warning).toBeUndefined();
  });

  it('sends the request body for a write operation', () => {
    const res = generateContractTest(context, { tool: 'create_pet' });
    expect(res.source).toContain('body: JSON.stringify(');
    expect(res.source).toContain("method: \"POST\"");
  });

  it('emits Python on request', () => {
    const res = generateContractTest(context, { tool: 'get_pet', language: 'python' });
    expect(res.language).toBe('python');
    expect(res.filename).toBe('get_pet_contract_test.py');
    expect(res.source).toContain('import requests');
    expect(res.source).toContain('def test_get_pet_contract():');
    expect(res.source).toContain('assert res.ok');
    expect(res.source).toContain('timeout=30');
  });

  it('emits a bash/curl script on request, and accepts "curl" as an alias', () => {
    const res = generateContractTest(context, { tool: 'get_pet', language: 'bash' });
    expect(res.filename).toBe('get_pet.contract.sh');
    expect(res.source).toContain('set -euo pipefail');
    expect(res.source).toContain("-X 'GET'");
    expect(generateContractTest(context, { tool: 'get_pet', language: 'curl' }).language).toBe('bash');
  });

  // Caught by actually running a generated script: inside single quotes the
  // shell never expands $API_KEY, so the literal text was being sent upstream
  // as the credential.
  it('lets the shell expand the API key in a bash auth header', () => {
    const res = generateContractTest(context, { tool: 'get_pet', language: 'bash' });
    expect(res.source).toContain('"$API_KEY"');
    // The broken form: the whole header single-quoted, variable inert.
    expect(res.source).not.toContain("'Authorization: Bearer $API_KEY'");
    // The literal part is still single-quoted, so it cannot be interpreted.
    expect(res.source).toContain(`-H 'Authorization: Bearer '"$API_KEY"`);
  });

  it('still single-quotes a bash header with no key placeholder', () => {
    const withHeader = ctx([
      action({
        name: 'tagged',
        method: 'GET',
        path: '/tagged',
        auth: 'none',
        paramsSchema: {
          type: 'object',
          properties: { 'X-Trace': param('header', 'string', { example: 'abc' }) },
        },
      }),
    ]);
    const res = generateContractTest(withHeader, { tool: 'tagged', language: 'bash' });
    expect(res.source).toContain(`-H 'X-Trace: abc'`);
    expect(res.source).not.toContain('"$API_KEY"');
  });

  it('escapes a hostile header name even while expanding the key', () => {
    const hostile = ctx([
      action({
        name: 'sneaky_header',
        method: 'GET',
        path: '/x',
        auth: 'apiKey',
        authIn: { in: 'header', name: "X'; rm -rf /; echo '" },
      }),
    ]);
    const res = generateContractTest(hostile, { tool: 'sneaky_header', language: 'bash' });
    expect(res.source).toContain('"$API_KEY"');
    // The injected quote is neutralized by close/escape/reopen.
    expect(res.source).toContain(`'\\''`);
    expect(res.source).not.toMatch(/-H 'X'; rm -rf \//);
  });

  it('falls back to TypeScript for an unknown language', () => {
    expect(generateContractTest(context, { tool: 'get_pet', language: 'cobol' }).language).toBe('typescript');
  });

  it('converts Python booleans and nulls in a request body literal', () => {
    const withBody = ctx([
      action({
        name: 'toggle',
        method: 'POST',
        path: '/toggle',
        safety: 'write',
        paramsSchema: {
          type: 'object',
          required: ['body'],
          properties: {
            body: param('body', 'object', {
              required: ['enabled'],
              properties: { enabled: { type: 'boolean', example: true } },
            }),
          },
        },
      }),
    ]);
    const res = generateContractTest(withBody, { tool: 'toggle', language: 'python' });
    expect(res.source).toContain('True');
    expect(res.source).not.toMatch(/json=\{"enabled": true\}/);
  });

  // Codegen injection: a hostile spec must produce escaped literals, never
  // executable code in any of the three targets.
  it('escapes a hostile field name instead of emitting it as code', () => {
    const hostile = ctx([
      action({
        name: 'evil',
        method: 'GET',
        path: '/evil',
        responseSchema: {
          type: 'object',
          required: ["x'; process.exit(1); //"],
          properties: { "x'; process.exit(1); //": { type: 'string' } },
        },
      }),
    ]);

    const ts = generateContractTest(hostile, { tool: 'evil' });
    // Not emitted as a bare property access — it goes through a quoted index.
    expect(ts.source).toContain('sample?.["x\'; process.exit(1); //"]');
    expect(ts.source).not.toMatch(/sample\?\.x'; process\.exit/);

    const sh = generateContractTest(hostile, { tool: 'evil', language: 'bash' });
    // Single-quote escaping closes, escapes, and reopens the quote.
    expect(sh.source).toContain(`'x'\\''; process.exit(1); //'`);

    const py = generateContractTest(hostile, { tool: 'evil', language: 'python' });
    expect(py.source).toContain('"x\'; process.exit(1); //" in sample');
  });

  it('escapes a hostile URL in the bash target', () => {
    const hostile = ctx([
      action({
        name: 'sneaky',
        method: 'GET',
        path: "/x'; rm -rf /tmp; echo '",
      }),
    ]);
    const sh = generateContractTest(hostile, { tool: 'sneaky', language: 'bash' });
    expect(sh.source).not.toMatch(/-X 'GET' '[^']*'; rm -rf/);
    expect(sh.source).toContain(`'\\''`);
  });

  it('flags drift already observed against the documented fields', () => {
    const drifted = ctx(petstoreActions(), {
      driftObservations: [{ actionId: 'id_get_pet', matchedFields: 1, declaredFields: 2, mismatches: ['name'] }],
    });
    const res = generateContractTest(drifted, { tool: 'get_pet' });
    expect(res.heedsUp).toContain('name');
    expect(res.heedsUp).toContain('1 documented field');
  });

  it('tells the caller which env var to set, and when it is optional', () => {
    expect(generateContractTest(context, { tool: 'get_pet' }).setup).toContain('API_KEY');
    const open = ctx([action({ name: 'ping', method: 'GET', path: '/ping', auth: 'none' })]);
    expect(generateContractTest(open, { tool: 'ping' }).setup).toContain('may be left empty');
  });
});
