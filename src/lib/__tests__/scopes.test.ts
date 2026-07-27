// OAuth2/OIDC scope capture. Until now the normalizer read only
// `Object.keys(requirement)` off a security requirement — the scope array,
// which is the whole point of a requirement (`{ oauth2: ['write:orders'] }`),
// was thrown away. This pins that it survives, and that it survives ONLY where
// it means something.

import { describe, expect, it } from 'vitest';
import { normalizeOpenApi } from '../normalize';

function specWith(opts: {
  schemeType: string;
  scheme?: string;
  operationSecurity?: unknown;
  rootSecurity?: unknown;
}) {
  const securityScheme: Record<string, unknown> = { type: opts.schemeType };
  if (opts.scheme) securityScheme.scheme = opts.scheme;
  if (opts.schemeType === 'apiKey') {
    securityScheme.in = 'header';
    securityScheme.name = 'X-Api-Key';
  }
  if (opts.schemeType === 'oauth2') {
    securityScheme.flows = { clientCredentials: { tokenUrl: 'https://auth.example.com/token', scopes: {} } };
  }

  return {
    openapi: '3.0.3',
    info: { title: 'Scoped API', version: '1.0.0' },
    servers: [{ url: 'https://api.example.com' }],
    components: { securitySchemes: { auth: securityScheme } },
    ...(opts.rootSecurity !== undefined ? { security: opts.rootSecurity } : {}),
    paths: {
      '/orders': {
        post: {
          operationId: 'createOrder',
          ...(opts.operationSecurity !== undefined ? { security: opts.operationSecurity } : {}),
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  };
}

describe('scope capture — oauth2', () => {
  it('captures scopes declared on an operation-level requirement', () => {
    const spec = specWith({ schemeType: 'oauth2', operationSecurity: [{ auth: ['write:orders', 'read:orders'] }] });
    const [action] = normalizeOpenApi(spec).actions;
    expect(action.auth).toBe('oauth2');
    expect(action.scopes).toEqual(['write:orders', 'read:orders']);
  });

  it('captures scopes declared at the document root and inherited by the operation', () => {
    const spec = specWith({ schemeType: 'oauth2', rootSecurity: [{ auth: ['read:orders'] }] });
    const [action] = normalizeOpenApi(spec).actions;
    expect(action.scopes).toEqual(['read:orders']);
  });

  it('lets an operation-level requirement override the root scopes', () => {
    const spec = specWith({
      schemeType: 'oauth2',
      rootSecurity: [{ auth: ['read:orders'] }],
      operationSecurity: [{ auth: ['admin:orders'] }],
    });
    const [action] = normalizeOpenApi(spec).actions;
    expect(action.scopes).toEqual(['admin:orders']);
  });

  it('leaves scopes undefined — not an empty array — when the requirement lists none', () => {
    const spec = specWith({ schemeType: 'oauth2', operationSecurity: [{ auth: [] }] });
    const [action] = normalizeOpenApi(spec).actions;
    expect(action.auth).toBe('oauth2');
    expect(action.scopes).toBeUndefined();
  });

  it('ignores non-string entries in a malformed scope array rather than throwing', () => {
    const spec = specWith({ schemeType: 'oauth2', operationSecurity: [{ auth: ['read:orders', 42, null, ''] }] });
    const [action] = normalizeOpenApi(spec).actions;
    expect(action.scopes).toEqual(['read:orders']);
  });

  it('captures scopes for openIdConnect too, since it maps to the same oauth2 auth scheme', () => {
    const spec = specWith({ schemeType: 'openIdConnect', operationSecurity: [{ auth: ['profile'] }] });
    const [action] = normalizeOpenApi(spec).actions;
    expect(action.auth).toBe('oauth2');
    expect(action.scopes).toEqual(['profile']);
  });
});

describe('scope capture — non-oauth2 schemes never get scopes', () => {
  // A security requirement's array is conventionally empty for these schemes,
  // but even a spec that populates one anyway must not have it attached — an
  // apiKey scheme has no notion of scopes, and reporting one would misrepresent
  // it as scope-gated.
  it('never attaches scopes to an apiKey scheme', () => {
    const spec = specWith({ schemeType: 'apiKey', operationSecurity: [{ auth: ['should-be-ignored'] }] });
    const [action] = normalizeOpenApi(spec).actions;
    expect(action.auth).toBe('apiKey');
    expect(action.scopes).toBeUndefined();
  });

  it('never attaches scopes to a bearer scheme', () => {
    const spec = specWith({ schemeType: 'http', scheme: 'bearer', operationSecurity: [{ auth: ['ignored'] }] });
    const [action] = normalizeOpenApi(spec).actions;
    expect(action.auth).toBe('bearer');
    expect(action.scopes).toBeUndefined();
  });

  it('has no scopes when there is no security requirement at all', () => {
    const spec = specWith({ schemeType: 'oauth2' });
    const [action] = normalizeOpenApi(spec).actions;
    expect(action.auth).toBe('none');
    expect(action.scopes).toBeUndefined();
  });
});
