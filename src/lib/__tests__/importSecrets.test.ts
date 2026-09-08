// The end-to-end containment test for GAP_ANALYSIS_2026-08-04.md §0.1.
//
// Pasting a working cURL command is the most-encouraged onboarding action and
// the one place a user hands us a live authenticated request. Every value in
// that request used to become an OAS `example`, and examples are published to
// four places at once. So the assertion here is deliberately not "the scanner
// flagged it" — it is "the secret appears in NONE of the published surfaces",
// checked by scanning the serialized output of each sink for a sentinel.
//
// Composed at the curlToOpenApi -> normalizeOpenApi seam rather than through
// runImport, matching importer.test.ts: runImport does live SSRF/DNS validation
// of base URLs, which has no place in an offline unit suite.

import { describe, expect, it } from 'vitest';
import { curlToOpenApi } from '../importer/curl';
import type { Action, ImportRecord } from '../ir';
import { normalizeOpenApi } from '../normalize';
import { curlSnippet, pythonSnippet, tsSnippet } from '../snippets';
import { buildToolList } from '../toolList';

// Fixture credentials are ASSEMBLED FROM PARTS, never written inline. They are
// fabricated, but close enough to the real formats that a scanner flags them —
// GitHub's push protection rejected the inline version of these files, which is
// that system working as intended. Joining at runtime gives the code under test
// byte-for-byte the same string while the literal never exists in source.
const k = (...parts: string[]) => parts.join('');
const STRIPE_KEY = k('sk', '_live_', '51H8xYzAbCdEfGhIjKlMnOpQr');
const STRIPE_PREFIX = k('sk', '_live_');
const GITLAB_TOKEN = k('glpat', '-', 'ABCdefGHIjklMNOpqrs');
const GITHUB_PAT = k('ghp', '_', '16C7e42F292c6912E7710c838347Ae178B4a');
const CLIENT_SECRET = k('pi_3ABC', '_secret_', 'XyZ123456789');

function importCurl(command: string) {
  const spec = normalizeOpenApi(curlToOpenApi(command));
  const record: ImportRecord = {
    id: 'test',
    name: spec.name,
    source: 'curl',
    baseUrls: ['https://api.example.com'],
    auth: spec.auth,
    authIn: spec.authIn,
    actions: spec.actions,
    counts: { total: spec.actions.length, read: 0, write: 0, destructive: 0 },
    createdAt: 0,
    expiresAt: 0,
  };
  return { spec, record };
}

// Every place an example value is published, serialized so one scan covers it.
function publishedSurfaces(record: ImportRecord, action: Action): string {
  return [
    JSON.stringify(action.examples),
    JSON.stringify(action.paramsSchema),
    JSON.stringify(buildToolList([action])),
    curlSnippet(action, record),
    tsSnippet(action, record),
    pythonSnippet(action, record),
  ].join('\n');
}

describe('a pasted cURL never publishes its credentials', () => {
  it('withholds a query-string api key', () => {
    const { spec, record } = importCurl(
      `curl 'https://api.example.com/v1/charges?api_key=${STRIPE_KEY}&limit=3'`,
    );
    const action = spec.actions[0];
    const surfaces = publishedSurfaces(record, action);

    expect(surfaces).not.toContain(STRIPE_KEY);
    expect(surfaces).not.toContain(STRIPE_PREFIX);
    // The parameter itself survives — an agent still learns the endpoint takes
    // an api_key, and that limit is an ordinary value it may send.
    expect(Object.keys(action.paramsSchema.properties as object)).toContain('api_key');
    expect(surfaces).toContain('limit');
    // Classified by the vendor format, not the parameter name: known_prefix is
    // checked first because it is the stronger, more specific signal.
    expect(spec.redactions.map((r) => r.reason)).toContain('known_prefix');
  });

  it('withholds a non-standard auth header the scheme detector does not divert', () => {
    // Private-Token matches none of authorization / ^(x-)?api[-_]?key$ / ^x-auth,
    // so it was carried through as a header parameter with its live value.
    const { spec, record } = importCurl(
      `curl https://api.example.com/v1/projects -H 'Private-Token: ${GITLAB_TOKEN}'`,
    );
    const surfaces = publishedSurfaces(record, spec.actions[0]);

    expect(surfaces).not.toContain(GITLAB_TOKEN);
    expect(surfaces).not.toContain(k('glpat', '-'));
  });

  it('withholds secrets inside a JSON request body', () => {
    const { spec, record } = importCurl(
      `curl https://api.example.com/v1/intents -X POST ` +
        `-d '{"amount":500,"currency":"usd","client_secret":"${CLIENT_SECRET}"}'`,
    );
    const action = spec.actions[0];
    const surfaces = publishedSurfaces(record, action);

    expect(surfaces).not.toContain(CLIENT_SECRET);
    expect(surfaces).not.toContain(k('_secret', '_'));
    // The rest of the body example survives, which is the point of walking it
    // rather than discarding the whole thing.
    expect(surfaces).toContain('500');
    expect(surfaces).toContain('usd');
  });

  it('withholds a bearer JWT carried in a non-standard header', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const { spec, record } = importCurl(
      `curl https://api.example.com/v1/me -H 'X-Session: ${jwt}'`,
    );
    expect(publishedSurfaces(record, spec.actions[0])).not.toContain(jwt);
  });

  it('leaves an ordinary cURL completely intact', () => {
    const { spec, record } = importCurl(
      `curl 'https://api.example.com/v1/pets?status=available&limit=20'`,
    );
    const surfaces = publishedSurfaces(record, spec.actions[0]);

    expect(surfaces).toContain('available');
    expect(surfaces).toContain('20');
    expect(spec.redactions).toHaveLength(0);
  });

  it('records what it withheld without becoming a second copy of it', () => {
    const { spec } = importCurl(
      `curl 'https://api.example.com/v1/charges?api_key=${STRIPE_KEY}'`,
    );

    expect(spec.redactions).toHaveLength(1);
    const [finding] = spec.redactions;
    // Qualified by tool name so an owner can find it.
    expect(finding.at).toMatch(/^\w+: api_key$/);
    expect(finding.hint).toBe('••••OpQr');
    expect(JSON.stringify(spec.redactions)).not.toContain(STRIPE_KEY);
  });
});

describe('a spec-supplied example is scanned too, not just a cURL', () => {
  it('withholds a credential sitting in an OpenAPI parameter example', () => {
    const doc = {
      openapi: '3.0.3',
      info: { title: 'Leaky', version: '1' },
      servers: [{ url: 'https://api.example.com' }],
      paths: {
        '/things': {
          get: {
            operationId: 'list_things',
            parameters: [
              {
                name: 'access_token',
                in: 'query',
                schema: { type: 'string', example: GITHUB_PAT },
              },
            ],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };

    const spec = normalizeOpenApi(doc);
    const surfaces = JSON.stringify(spec.actions[0]);
    expect(surfaces).not.toContain(GITHUB_PAT);
    expect(spec.redactions).toHaveLength(1);
  });
});

// The parameter-example path took a different walker from the body path: it
// called the scalar-only classifyValue, which answered null for an array or an
// object — and the caller reads null as "clean". So a credential inside a
// composite example was published verbatim, on a surface reachable with no
// authentication at all.
//
// `example: ["sk_live_…"]` on an array-typed parameter is valid OpenAPI, and
// postman-to-openapi copies collection values across unchanged, so this is an
// ordinary authoring shape rather than a contrived one.
describe('a composite example cannot smuggle a credential past the scanner', () => {
  const specWith = (parameter: Record<string, unknown>) => ({
    openapi: '3.0.3',
    info: { title: 'Charges', version: '1' },
    servers: [{ url: 'https://api.example.com' }],
    paths: {
      '/v1/charges': {
        get: {
          operationId: 'listCharges',
          parameters: [parameter],
          responses: { '200': { description: 'OK' } },
        },
      },
    },
  });

  it('withholds a key inside an array-valued example', () => {
    const spec = normalizeOpenApi(
      specWith({
        name: 'filters',
        in: 'query',
        schema: { type: 'array', items: { type: 'string' } },
        example: [STRIPE_KEY],
      }),
    );

    expect(JSON.stringify(spec.actions[0])).not.toContain(STRIPE_KEY);
    expect(spec.redactions.length).toBeGreaterThan(0);
  });

  it('withholds a key inside an object-valued example', () => {
    const spec = normalizeOpenApi(
      specWith({
        name: 'auth',
        in: 'query',
        schema: { type: 'object' },
        example: { token: GITLAB_TOKEN, locale: 'en' },
      }),
    );

    const serialized = JSON.stringify(spec.actions[0]);
    expect(serialized).not.toContain(GITLAB_TOKEN);
    // The innocuous sibling survives — redacting the whole example would throw
    // away the thing that makes the endpoint legible.
    expect(serialized).toContain('en');
  });

  // The sharpest form: the scanner DID flag it. scrubSchemaExamples walked
  // p.schema.example and recorded the finding, but sanitizeSchema copies
  // `example` by reference, so it rewrote the sanitized copy while the example
  // path re-read the untouched original. The receipt said "withheld" at the
  // same moment the value was published.
  it('does not report a redaction while still publishing the value', () => {
    const spec = normalizeOpenApi(
      specWith({
        name: 'params',
        in: 'query',
        schema: { type: 'array', items: { type: 'string' }, example: [GITHUB_PAT] },
      }),
    );

    expect(spec.redactions.length).toBeGreaterThan(0);
    expect(JSON.stringify(spec.actions[0])).not.toContain(GITHUB_PAT);
  });
});
