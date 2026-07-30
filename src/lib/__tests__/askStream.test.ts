// Asserts what streamAskAboutApi actually puts on the wire.
//
// The client's live tool trace is built entirely from `tool-*` SSE chunks, so
// "the tools are passed to toUIMessageStream" is not a detail — omit it and every
// call surfaces as `dynamic-tool`, the trace loses its tool names, and the
// feature quietly degrades to a spinner. That is asserted here rather than left
// to a code comment.

import { describe, expect, it } from 'vitest';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
// The generic on simulateReadableStream has to be explicit. Left to inference,
// each chunk literal widens into its own shape and the resulting union no longer
// matches LanguageModelV4StreamResult, so doStream fails to typecheck even though
// it behaves correctly at runtime. `satisfies` does not help — it checks the
// literal without changing what the stream is inferred as.
import type {
  LanguageModelV4FinishReason,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';
import { emptyInsights, type AdvisorContext } from '../advisor';
import { streamAskAboutApi, type AskOutcome } from '../ask';
import type { Action, ImportRecord } from '../ir';
import type { UIMessage } from 'ai';

function action(o: { name: string; method: string; path: string }): Action {
  return {
    id: `id_${o.name}`,
    name: o.name,
    description: `Does ${o.name}`,
    method: o.method,
    path: o.path,
    paramsSchema: { type: 'object', properties: {} },
    auth: 'none',
    safety: 'read',
    operationStability: 'documented',
    idempotency: 'unknown',
    requiresConfirmation: false,
    confidence: 1,
    examples: [],
  } as unknown as Action;
}

const record = {
  name: 'Petstore',
  source: 'openapi',
  baseUrls: ['https://petstore3.swagger.io/api/v3'],
  auth: 'none',
  actions: [action({ name: 'get_pet_by_id', method: 'GET', path: '/pet/{petId}' })],
} as unknown as ImportRecord;

const ctx = (): AdvisorContext => ({ record, insights: emptyInsights() });
const ask = (text: string): UIMessage[] => [
  { id: 'm1', role: 'user', parts: [{ type: 'text', text }] },
];

// v4 widened both of these from flat values into objects. Spelling them out
// rather than casting, so a future provider-spec change fails here loudly
// instead of being papered over by an `as`.
// Note the two are NOT the same shape: input splits by cache, output by kind.
const USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const finished = (unified: LanguageModelV4FinishReason['unified']): LanguageModelV4FinishReason => ({
  unified,
  raw: undefined,
});

function textModel(text: string) {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream<LanguageModelV4StreamPart>({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: '0' },
          { type: 'text-delta', id: '0', delta: text },
          { type: 'text-end', id: '0' },
          { type: 'finish', finishReason: finished('stop'), usage: USAGE },
        ],
      }),
    }),
  });
}

async function collect(res: Response): Promise<string> {
  expect(res.body).toBeTruthy();
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

// smoothStream chunks by word, so prose arrives as many text-delta chunks and is
// never contiguous in the raw SSE. Reassembling is what a client does, so it is
// also what the assertions should do.
function answerText(body: string): string {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6))
    .filter((payload) => payload !== '[DONE]')
    .map((payload) => JSON.parse(payload) as { type: string; delta?: string })
    .filter((chunk) => chunk.type === 'text-delta')
    .map((chunk) => chunk.delta ?? '')
    .join('');
}

describe('streamAskAboutApi', () => {
  it('streams an SSE UI message stream', async () => {
    const res = await streamAskAboutApi(ctx(), ask('hi'), { model: textModel('petId is a path parameter.') });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const body = await collect(res);
    expect(answerText(body)).toBe('petId is a path parameter.');
  });

  it('reports a clean finish through onOutcome', async () => {
    const outcomes: AskOutcome[] = [];
    const res = await streamAskAboutApi(ctx(), ask('hi'), {
      model: textModel('done'),
      onOutcome: (o) => outcomes.push(o),
    });
    await collect(res);
    expect(outcomes.at(-1)).toMatchObject({ status: 'ok' });
  });

  // A tool call must arrive as `tool-<name>`, not `dynamic-tool`. This is what
  // lets the client render "traced petId" instead of an anonymous spinner.
  it('surfaces an advisor tool call as a named tool part', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream<LanguageModelV4StreamPart>({
          chunks: [
            { type: 'stream-start', warnings: [] },
            {
              type: 'tool-call',
              toolCallId: 'call_1',
              toolName: 'docentapi_search_endpoints',
              input: JSON.stringify({ query: 'pet' }),
            },
            { type: 'finish', finishReason: finished('tool-calls'), usage: USAGE },
          ],
        }),
      }),
    });
    const body = await collect(await streamAskAboutApi(ctx(), ask('find pet endpoints'), { model }));
    // The chunk carries the tool NAME, which is what the client turns into a
    // `tool-docentapi_search_endpoints` part and then into the trace label
    // "searched endpoints". A dynamic-tool chunk would carry no usable name.
    expect(body).toContain('"type":"tool-input-available"');
    expect(body).toContain('"toolName":"docentapi_search_endpoints"');
    expect(body).not.toContain('dynamic-tool');
    // The advisor tool really executed server-side, so its result is on the wire
    // too — the trace shows a finished check, not just an attempted one.
    expect(body).toContain('"type":"tool-output-available"');
    expect(body).toContain('get_pet_by_id');
  });

  // A model failure after headers are sent cannot be a 502 any more. It has to
  // arrive as an in-stream error part, with the detail redacted, and it must
  // still reach onOutcome so the ledger records the turn.
  it('reports a model failure in-stream without leaking provider detail', async () => {
    const outcomes: AskOutcome[] = [];
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error('azure said 401 with key sk-secret-do-not-log');
      },
    });
    const res = await streamAskAboutApi(ctx(), ask('hi'), {
      model,
      onOutcome: (o) => outcomes.push(o),
    });
    const body = await collect(res);
    expect(body).toContain('The assistant could not finish that answer.');
    expect(body).not.toContain('sk-secret-do-not-log');
    expect(body).not.toContain('401');
    expect(outcomes.at(-1)?.status).toBe('error');
  });
});
