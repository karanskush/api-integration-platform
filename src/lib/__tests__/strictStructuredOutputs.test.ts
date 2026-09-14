// Every generateObject schema in this codebase reaches OpenAI-compatible
// providers as `response_format: { type: 'json_schema', strict: true }` —
// @ai-sdk/openai and @ai-sdk/azure set strict by default. Strict mode has a rule
// zod does not enforce: every property of every object must be listed in
// `required`, and `additionalProperties` must be false. zod emits an .optional()
// field OUTSIDE `required`, so the provider rejects the whole request with a 400
// before the model runs.
//
// That is how enrichment, triage and synthesis failed every chunk on Azure
// gpt-5-mini from 2026-07-30 to 2026-09-14 while ask (plain generateText, no
// response_format) answered fine: production's only enrichment run recorded
// chunksTotal 3, chunksSucceeded 0, and the reason went only to runtime logs.
// The fix is spelling optional as .nullable(); this test keeps it that way, and
// checks the bytes actually sent for one schema, not just zod's own rendering.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateObject } from 'ai';
import { z } from 'zod';
import { enrichLanguageModel } from '../ask';
import { ChunkOutputSchema } from '../deepEnrich';
import { TriageOutputSchema } from '../clarify/triage';
import { SynthesisOutputSchema } from '../clarify/synthesize';

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: unknown;
  items?: JsonSchema | JsonSchema[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
};

// The two strict-mode rules OpenAI documents for every object node, applied
// recursively. Returns human-readable violations so a failure names the field.
export function strictModeViolations(node: JsonSchema | undefined, path = '$'): string[] {
  if (!node || typeof node !== 'object') return [];
  const out: string[] = [];
  if (node.properties) {
    const keys = Object.keys(node.properties);
    const required = new Set(node.required ?? []);
    for (const k of keys) if (!required.has(k)) out.push(`${path}.${k} is not in required`);
    if (node.additionalProperties !== false) out.push(`${path} does not set additionalProperties: false`);
    for (const k of keys) out.push(...strictModeViolations(node.properties[k], `${path}.${k}`));
  }
  if (node.items) {
    for (const [i, item] of (Array.isArray(node.items) ? node.items : [node.items]).entries()) {
      out.push(...strictModeViolations(item, `${path}[${i}]`));
    }
  }
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    for (const [i, alt] of (node[key] ?? []).entries()) out.push(...strictModeViolations(alt, `${path}.${key}[${i}]`));
  }
  return out;
}

const render = (schema: z.ZodType) => z.toJSONSchema(schema, { target: 'draft-7' }) as JsonSchema;

describe('strict json_schema compatibility of every generateObject schema', () => {
  it('flags an .optional() field, so the rule below is actually being checked', () => {
    const bad = z.object({ a: z.string(), b: z.string().optional() });
    expect(strictModeViolations(render(bad))).toEqual(['$.b is not in required']);
  });

  it('accepts .nullable(), the strict-mode spelling of optional', () => {
    const good = z.object({ a: z.string(), b: z.string().nullable(), c: z.array(z.string()).nullable() });
    expect(strictModeViolations(render(good))).toEqual([]);
  });

  it.each([
    ['deepEnrich ChunkOutputSchema', ChunkOutputSchema],
    ['clarify TriageOutputSchema', TriageOutputSchema],
    ['clarify SynthesisOutputSchema', SynthesisOutputSchema],
  ])('%s has every property required and no open objects', (_name, schema) => {
    expect(strictModeViolations(render(schema))).toEqual([]);
  });
});

// The bytes on the wire, not zod's rendering: drive the real Azure provider
// through the fetch seam with production's configuration (dated api-version,
// a gpt-5 deployment) and inspect the response_format it sends.
const ENV_KEYS = [
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_OPENAI_API_VERSION',
  'DOCENTAPI_ASK_MODEL',
  'DOCENTAPI_ENRICH_MODEL',
  'SPOTCHECK_ASK_MODEL',
  'OPENAI_API_KEY',
  'AI_GATEWAY_API_KEY',
  'VERCEL_OIDC_TOKEN',
] as const;

describe('the enrichment request Azure actually receives', () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.AZURE_OPENAI_API_KEY = 'test-key';
    process.env.AZURE_OPENAI_ENDPOINT = 'https://aoai-example.openai.azure.com/';
    process.env.AZURE_OPENAI_API_VERSION = '2024-12-01-preview';
    process.env.DOCENTAPI_ASK_MODEL = 'azure/gpt-5-mini';
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('sends strict json_schema whose every object passes the strict-mode rules', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl: typeof globalThis.fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ error: { message: 'captured by test' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    };
    await expect(
      generateObject({ model: enrichLanguageModel({ fetch: fetchImpl }), schema: ChunkOutputSchema, system: 's', prompt: 'p' }),
    ).rejects.toThrow();

    expect(bodies).toHaveLength(1);
    const body = bodies[0] as {
      model: string;
      messages: Array<{ role: string }>;
      temperature?: unknown;
      max_tokens?: unknown;
      response_format: { type: string; json_schema: { strict: boolean; schema: JsonSchema } };
    };
    // gpt-5 is a reasoning deployment: the system prompt travels as the developer
    // role and no sampling parameters are sent — both would be 400s otherwise.
    expect(body.model).toBe('gpt-5-mini');
    expect(body.messages[0].role).toBe('developer');
    expect(body.temperature).toBeUndefined();
    expect(body.max_tokens).toBeUndefined();
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(strictModeViolations(body.response_format.json_schema.schema)).toEqual([]);
  });
});
