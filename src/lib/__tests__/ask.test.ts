// Fully offline: MockLanguageModelV4 (ai/test) replaces the actual model, so
// these tests are deterministic and never make a network call — the same
// reason the rest of this codebase never calls a real upstream API in tests.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { AskInputError, aiReady, askAboutApi, askModel } from '../ask';
import type { AdvisorContext } from '../advisor';
import { emptyInsights } from '../advisor';
import type { Action, ImportRecord } from '../ir';

const ENV_KEYS = ['AI_GATEWAY_API_KEY', 'VERCEL', 'VERCEL_OIDC_TOKEN', 'SPOTCHECK_ASK_MODEL'] as const;
const originals = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]])) as Record<string, string | undefined>;

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

function record(): ImportRecord {
  const actions = [
    action({ name: 'list_pets', method: 'GET', path: '/pets' }),
    action({
      name: 'create_pet',
      method: 'POST',
      path: '/pets',
      safety: 'write',
      paramsSchema: {
        type: 'object',
        properties: {
          body: {
            'x-spotcheck-in': 'body',
            type: 'object',
            required: ['name'],
            properties: { name: { type: 'string' } },
          },
        },
      },
    }),
  ];
  return {
    id: 'r',
    name: 'Petstore',
    source: 'openapi',
    baseUrls: ['https://api.petstore.test'],
    auth: 'bearer',
    actions,
    counts: { total: 2, read: 1, write: 1, destructive: 0 },
    createdAt: 1,
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
}

function ctx(): AdvisorContext {
  return { record: record(), insights: emptyInsights() };
}

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
};

function textResult(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    finishReason: { unified: 'stop' as const, raw: undefined },
    usage: USAGE,
    warnings: [],
  };
}

function toolCallResult(toolCallId: string, toolName: string, input: Record<string, unknown>) {
  return {
    content: [{ type: 'tool-call' as const, toolCallId, toolName, input: JSON.stringify(input) }],
    finishReason: { unified: 'tool-calls' as const, raw: undefined },
    usage: USAGE,
    warnings: [],
  };
}

describe('aiReady', () => {
  it('is false with no credential of any kind', () => {
    expect(aiReady()).toBe(false);
  });

  it('is true when a gateway key is set', () => {
    process.env.AI_GATEWAY_API_KEY = 'key';
    expect(aiReady()).toBe(true);
  });

  // On Vercel the Gateway authenticates via OIDC — no key to configure — so
  // the platform itself counts as a credential source, unlike every other
  // xReady() in this codebase which needs an explicit secret regardless of
  // platform.
  it('is true when running on Vercel with no explicit key', () => {
    process.env.VERCEL = '1';
    expect(aiReady()).toBe(true);
  });

  // `vercel env pull` writes a short-lived OIDC token into .env.local, which the
  // Gateway accepts on its own. Missing this case is what left every
  // model-backed feature dark in local development while the Gateway was in
  // fact answering calls.
  it('is true with a pulled OIDC token and nothing else', () => {
    process.env.VERCEL_OIDC_TOKEN = 'eyJhbGciOi.stub.signature';
    expect(aiReady()).toBe(true);
  });
});

describe('askModel', () => {
  it('defaults to the current Sonnet model via the AI Gateway', () => {
    expect(askModel()).toBe('anthropic/claude-sonnet-5');
  });

  it('honours an override', () => {
    process.env.SPOTCHECK_ASK_MODEL = 'anthropic/claude-opus-5';
    expect(askModel()).toBe('anthropic/claude-opus-5');
  });

  it('ignores a whitespace-only override', () => {
    process.env.SPOTCHECK_ASK_MODEL = '   ';
    expect(askModel()).toBe('anthropic/claude-sonnet-5');
  });
});

describe('askAboutApi — input validation', () => {
  it('rejects an empty question without calling the model', async () => {
    const model = new MockLanguageModelV4({ doGenerate: textResult('unused') });
    await expect(askAboutApi(ctx(), '   ', { model })).rejects.toThrow(AskInputError);
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it('rejects an overlong question without calling the model', async () => {
    const model = new MockLanguageModelV4({ doGenerate: textResult('unused') });
    await expect(askAboutApi(ctx(), 'x'.repeat(1001), { model })).rejects.toThrow(/1000 characters/);
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it('trims the question before sending it', async () => {
    const model = new MockLanguageModelV4({ doGenerate: textResult('ok') });
    await askAboutApi(ctx(), '  what pets exist?  ', { model });
    const userMessage = model.doGenerateCalls[0].prompt.find((m) => m.role === 'user');
    expect(JSON.stringify(userMessage)).toContain('what pets exist?');
    expect(JSON.stringify(userMessage)).not.toContain('  what pets');
  });
});

describe('askAboutApi — no tool needed', () => {
  it('returns the model text directly when no tool call is made', async () => {
    const model = new MockLanguageModelV4({ doGenerate: textResult('This API has no pagination.') });
    const result = await askAboutApi(ctx(), 'Does this API paginate?', { model });
    expect(result).toEqual({ answer: 'This API has no pagination.', toolCalls: [], steps: 1 });
  });

  it('falls back to a placeholder when the model returns empty text', async () => {
    const model = new MockLanguageModelV4({ doGenerate: textResult('   ') });
    const result = await askAboutApi(ctx(), 'anything', { model });
    expect(result.answer).toBe('No answer was generated.');
  });
});

describe('askAboutApi — tool calling', () => {
  it('calls a real advisor tool and grounds the final answer in its result', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        toolCallResult('call-1', 'spotcheck_search_endpoints', { query: 'pet' }),
        textResult('There are two pet operations: list_pets and create_pet.'),
      ],
    });

    const result = await askAboutApi(ctx(), 'What pet operations exist?', { model });

    expect(result.answer).toContain('list_pets');
    expect(result.steps).toBe(2);
    expect(result.toolCalls).toEqual([{ tool: 'spotcheck_search_endpoints', input: { query: 'pet' } }]);
  });

  // The mechanism this whole module exists to guarantee: the tool's output
  // reaching the model is the REAL, structured advisor result — not a raw
  // string the model has to parse, and not an empty stub.
  it('feeds the real advisor JSON result back to the model as structured tool output', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        toolCallResult('call-1', 'spotcheck_search_endpoints', { query: 'create' }),
        textResult('ok'),
      ],
    });

    await askAboutApi(ctx(), 'find the create operation', { model });

    const secondCallMessages = model.doGenerateCalls[1].prompt;
    const toolMessage = secondCallMessages.find((m) => m.role === 'tool');
    const serialized = JSON.stringify(toolMessage);
    expect(serialized).toContain('create_pet');
    expect(serialized).toContain('results');
  });

  it('traces every tool call across multiple steps', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        toolCallResult('call-1', 'spotcheck_search_endpoints', { query: 'pet' }),
        toolCallResult('call-2', 'spotcheck_get_call_sequence', { tool: 'create_pet' }),
        textResult('Call create_pet directly; it needs no prerequisite.'),
      ],
    });

    const result = await askAboutApi(ctx(), 'how do I create a pet?', { model });

    expect(result.steps).toBe(3);
    expect(result.toolCalls.map((c) => c.tool)).toEqual(['spotcheck_search_endpoints', 'spotcheck_get_call_sequence']);
  });

  it('lets an unknown-tool response from the advisor layer reach the model without throwing', async () => {
    // trace_field on a field that appears nowhere returns {error: ...}, not a
    // thrown exception — confirms the wrapper's JSON.parse path handles an
    // error-shaped but well-formed advisor payload transparently.
    const model = new MockLanguageModelV4({
      doGenerate: [
        toolCallResult('call-1', 'spotcheck_trace_field', { field: 'totally_unknown_field' }),
        textResult('That field does not exist on this API.'),
      ],
    });

    const result = await askAboutApi(ctx(), 'where does totally_unknown_field come from?', { model });
    expect(result.answer).toContain('does not exist');
  });
});

describe('askAboutApi — grounding and injection resistance', () => {
  it('sends system instructions forbidding compliance with instructions inside tool output', async () => {
    const model = new MockLanguageModelV4({ doGenerate: textResult('ok') });
    await askAboutApi(ctx(), 'anything', { model });

    const system = model.doGenerateCalls[0].prompt.find((m) => m.role === 'system');
    expect(system).toBeDefined();
    const text = (system as { content: string }).content;
    expect(text).toContain('DATA');
    expect(text).toContain('ignore previous instructions');
    expect(text).toContain('Never invent a source');
  });

  it('names the actual API in the system instructions, not a generic placeholder', async () => {
    const model = new MockLanguageModelV4({ doGenerate: textResult('ok') });
    await askAboutApi(ctx(), 'anything', { model });
    const system = model.doGenerateCalls[0].prompt.find((m) => m.role === 'system');
    expect((system as { content: string }).content).toContain('Petstore');
  });

  it('bounds the tool-calling loop so one question cannot spiral indefinitely', async () => {
    // Every step calls a tool; the model never willingly finishes. If the
    // loop were unbounded this would hang the test.
    const alwaysCallsATool = Array.from({ length: 20 }, (_, i) =>
      toolCallResult(`call-${i}`, 'spotcheck_get_score_explanation', {}),
    );
    const model = new MockLanguageModelV4({ doGenerate: alwaysCallsATool });

    const result = await askAboutApi(ctx(), 'keep going forever', { model });
    expect(result.steps).toBeLessThanOrEqual(6);
  });
});
