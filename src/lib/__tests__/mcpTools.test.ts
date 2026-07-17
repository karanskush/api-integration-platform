import { describe, expect, it } from 'vitest';
import { callActionTool, invokeAction, type ToolCallTarget } from '../mcpTools';
import { SsrfError } from '../ssrf';
import type { Action } from '../ir';

// Every action below gets its own id: validateParams (validate.ts) caches
// compiled ajv validators keyed by action.id, so reusing one id across
// differently-shaped paramsSchemas within this file would serve a stale
// validator from an earlier test.
function action(overrides: Partial<Action> = {}): Action {
  return {
    id: 'a1',
    name: 'get_thing',
    description: 'Get a thing',
    method: 'GET',
    path: '/things',
    paramsSchema: { type: 'object', properties: {} },
    auth: 'none',
    safety: 'read',
    examples: [],
    ...overrides,
  };
}

describe('callActionTool', () => {
  it('errors when no base URL is configured', async () => {
    const a = action({ id: 'no-base-url' });
    const target: ToolCallTarget = { baseUrls: [] };
    const result = await callActionTool(a, {}, target, undefined);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('This API declared no public base URL — calls are disabled.');
  });

  it('errors on invalid args caught by validateParams', async () => {
    const a = action({
      id: 'invalid-args',
      paramsSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    });
    const target: ToolCallTarget = { baseUrls: ['https://api.example.com'] };
    const result = await callActionTool(a, {}, target, undefined);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^Invalid arguments:/);
  });

  it('errors when auth is required but no key is supplied', async () => {
    const a = action({ id: 'auth-required', auth: 'bearer' });
    const target: ToolCallTarget = { baseUrls: ['https://api.example.com'] };
    const result = await callActionTool(a, {}, target, undefined);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      'This API requires bearer auth. Supply your key via the x-spotcheck-upstream-key header (or ?key= in the server URL). Spotcheck never stores it.',
    );
  });

  // Real code path through buildUpstreamRequest → safeFetch, no real network
  // I/O: the SSRF guard rejects a link-local literal IP before any socket is
  // opened (see ssrf.test.ts for the same no-network testing approach).
  it('errors when the upstream URL is blocked by the SSRF guard', async () => {
    const a = action({ id: 'ssrf-blocked' });
    const target: ToolCallTarget = { baseUrls: ['http://169.254.169.254'] };
    const result = await callActionTool(a, {}, target, undefined);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Upstream URL blocked by safety policy.');
  });
});

describe('invokeAction', () => {
  it('throws when no base URL is configured', async () => {
    const a = action({ id: 'invoke-no-base-url' });
    const target: ToolCallTarget = { baseUrls: [] };
    await expect(invokeAction(a, {}, target, undefined)).rejects.toThrow(
      'This API declared no public base URL — calls are disabled.',
    );
  });

  it('throws on invalid args caught by validateParams', async () => {
    const a = action({
      id: 'invoke-invalid-args',
      paramsSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    });
    const target: ToolCallTarget = { baseUrls: ['https://api.example.com'] };
    await expect(invokeAction(a, {}, target, undefined)).rejects.toThrow(/^Invalid arguments:/);
  });

  it('throws when auth is required but no key is supplied', async () => {
    const a = action({ id: 'invoke-auth-required', auth: 'apiKey' });
    const target: ToolCallTarget = { baseUrls: ['https://api.example.com'] };
    await expect(invokeAction(a, {}, target, undefined)).rejects.toThrow(/requires apiKey auth/);
  });

  it('lets SsrfError propagate uncaught', async () => {
    const a = action({ id: 'invoke-ssrf-blocked' });
    const target: ToolCallTarget = { baseUrls: ['http://169.254.169.254'] };
    await expect(invokeAction(a, {}, target, undefined)).rejects.toThrow(SsrfError);
  });
});
