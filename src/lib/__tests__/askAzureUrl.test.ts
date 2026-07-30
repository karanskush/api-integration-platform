// The test that would have caught the outage.
//
// Every other ask test injects `opts.model`, so `askLanguageModel()` was never
// on a path that made a request — the four Azure tests in ask.test.ts assert
// `.provider` and `.modelId` on the returned object and stop there. Nothing in
// the suite ever observed a URL, an api-version, or a header, which is exactly
// how a provider path that had never once succeeded in production shipped green.
//
// So this file asserts on the wire, not on the object. `AzureOpenAIProviderSettings`
// accepts a custom `fetch`, and createAzure threads it into every model it builds,
// so we capture the outgoing request with no network and no mocking framework.
//
// The bug: @ai-sdk/azure@4 picks its request surface from `useDeploymentBasedUrls`
// and then stamps whatever apiVersion it was handed onto whichever surface it
// picked (dist/index.js:90-106) — it never checks the two agree. Since
// isAzureOpenAIBaseURL(undefined) is TRUE, omitting the flag lands on /openai/v1
// with a DATED api-version still attached, which Azure rejects with a fast 4xx.
// `it('never pairs the v1 surface with a dated api-version')` is the regression
// guard: it fails on the pre-fix code and passes after.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AskConfigError, aiReady, askLanguageModel, azureSurface } from '../ask';

const ENV_KEYS = [
  'AI_GATEWAY_API_KEY',
  'VERCEL',
  'VERCEL_OIDC_TOKEN',
  'DOCENTAPI_ASK_MODEL',
  'SPOTCHECK_ASK_MODEL',
  'OPENAI_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_OPENAI_RESOURCE_NAME',
  'AZURE_OPENAI_API_VERSION',
] as const;
const originals = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]])) as Record<
  string,
  string | undefined
>;

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originals[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

type Captured = { url: string; headers: Record<string, string> };

function captureFetch() {
  const calls: Captured[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

// Drives one real request through the provider and hands back what went out.
// The `.catch()` is deliberate: `{}` is not a valid chat-completions body, so
// doGenerate rejects while parsing the response — long after the URL was built.
// Swallowing that keeps these assertions about the request and immune to
// provider response-schema drift.
async function requestFor(): Promise<Captured> {
  const { calls, fetchImpl } = captureFetch();
  const model = askLanguageModel({ fetch: fetchImpl });
  if (typeof model === 'string') throw new Error(`expected a provider instance, got slug "${model}"`);
  await (model as unknown as {
    doGenerate(o: unknown): Promise<unknown>;
  })
    .doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
    .catch(() => undefined);
  expect(calls).toHaveLength(1);
  return calls[0];
}

function configureAzure() {
  process.env.AZURE_OPENAI_API_KEY = 'azure-key';
  process.env.AZURE_OPENAI_ENDPOINT = 'https://aoai-example.openai.azure.com/';
  process.env.DOCENTAPI_ASK_MODEL = 'azure/my-deploy';
}

describe('azureSurface', () => {
  it('routes a dated api-version to the legacy deployment surface', () => {
    expect(azureSurface('2024-12-01-preview')).toEqual({
      apiVersion: '2024-12-01-preview',
      useDeploymentBasedUrls: true,
    });
    expect(azureSurface('2025-04-01')).toEqual({
      apiVersion: '2025-04-01',
      useDeploymentBasedUrls: true,
    });
  });

  it('routes "preview" to the v1 surface', () => {
    expect(azureSurface('preview')).toEqual({ apiVersion: 'preview', useDeploymentBasedUrls: false });
  });

  // Normalised rather than passed through: the provider's own fallback is the
  // literal "v1", and ?api-version=v1 is not a value Azure accepts.
  it('normalises "v1" to "preview" rather than forwarding it', () => {
    expect(azureSurface('v1')).toEqual({ apiVersion: 'preview', useDeploymentBasedUrls: false });
  });

  it('defaults an unset value to the legacy surface, which every resource has', () => {
    expect(azureSurface(undefined)).toEqual({
      apiVersion: '2024-12-01-preview',
      useDeploymentBasedUrls: true,
    });
    expect(azureSurface('   ')).toEqual({
      apiVersion: '2024-12-01-preview',
      useDeploymentBasedUrls: true,
    });
  });

  it('rejects anything it does not recognise instead of guessing a surface', () => {
    expect(azureSurface('nonsense-9')).toBeNull();
    expect(azureSurface('2024-13')).toBeNull();
  });
});

describe('askLanguageModel — the Azure request that actually goes out', () => {
  it('sends a dated api-version to /openai/deployments/<deployment>', async () => {
    configureAzure();
    process.env.AZURE_OPENAI_API_VERSION = '2024-12-01-preview';
    const url = new URL((await requestFor()).url);
    expect(url.pathname).toBe('/openai/deployments/my-deploy/chat/completions');
    expect(url.searchParams.get('api-version')).toBe('2024-12-01-preview');
  });

  it('sends "preview" to /openai/v1, with the deployment in the body instead', async () => {
    configureAzure();
    process.env.AZURE_OPENAI_API_VERSION = 'preview';
    const url = new URL((await requestFor()).url);
    expect(url.pathname).toBe('/openai/v1/chat/completions');
    expect(url.searchParams.get('api-version')).toBe('preview');
  });

  it('pins the default surface when no api-version is configured', async () => {
    configureAzure();
    const url = new URL((await requestFor()).url);
    expect(url.pathname).toBe('/openai/deployments/my-deploy/chat/completions');
    expect(url.searchParams.get('api-version')).toBe('2024-12-01-preview');
  });

  // THE REGRESSION GUARD. Fails on the pre-fix code for every dated api-version.
  it.each(['2024-12-01-preview', '2025-04-01', undefined])(
    'never pairs the v1 surface with a dated api-version (%s)',
    async (apiVersion) => {
      configureAzure();
      if (apiVersion) process.env.AZURE_OPENAI_API_VERSION = apiVersion;
      const url = new URL((await requestFor()).url);
      const onV1 = url.pathname.startsWith('/openai/v1/');
      const dated = /^\d{4}-\d{2}-\d{2}/.test(url.searchParams.get('api-version') ?? '');
      expect(onV1 && dated).toBe(false);
    },
  );

  it('derives the host from the endpoint the Azure portal shows', async () => {
    configureAzure();
    expect(new URL((await requestFor()).url).origin).toBe('https://aoai-example.openai.azure.com');
  });

  // The key travels as a header. Asserted because logModelFailure records
  // APICallError.url, so a key that leaked into the query string would be logged.
  it('sends the key as a header and never in the URL', async () => {
    configureAzure();
    const captured = await requestFor();
    expect(captured.headers['api-key']).toBe('azure-key');
    expect(captured.url).not.toContain('azure-key');
  });

  it('refuses to build a model for an unrecognised api-version', async () => {
    configureAzure();
    process.env.AZURE_OPENAI_API_VERSION = 'nonsense-9';
    expect(aiReady()).toBe(false);
    const { calls, fetchImpl } = captureFetch();
    expect(() => askLanguageModel({ fetch: fetchImpl })).toThrow(AskConfigError);
    expect(calls).toHaveLength(0);
  });
});

describe('askLanguageModel — direct OpenAI', () => {
  // Note the asymmetry with Azure above: platform OpenAI is built via the
  // provider's default callable, which is .responses(), while the Azure branch
  // pins .chat() explicitly. Asserted rather than glossed over, because the paths
  // differ and a future change to either should have to update this line.
  it('goes straight to api.openai.com on the Responses API', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.DOCENTAPI_ASK_MODEL = 'openai/gpt-5-mini';
    const captured = await requestFor();
    expect(captured.url).toBe('https://api.openai.com/v1/responses');
    expect(captured.headers.authorization).toBe('Bearer sk-test');
  });
});
