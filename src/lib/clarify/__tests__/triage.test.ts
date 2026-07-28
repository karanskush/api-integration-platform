// Offline: MockLanguageModelV4 replaces the model, so every gate is exercised
// deterministically. The cases that matter are the rejections — a triage pass
// that accepts everything it is told is the failure this whole module exists to
// prevent.

import { describe, expect, it } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { retirementCap, triageQuestions, type TriageCandidate } from '../triage';
import type { AnswerSpec } from '../archetypes';

const SPEC_TEXT =
  'The identifier is assigned by the server on creation and any value supplied by the caller is ignored entirely.';
const REAL_QUOTE = 'assigned by the server on creation and any value supplied by the caller is ignored';

const answerSpec: AnswerSpec = {
  kind: 'single_choice',
  allowOther: true,
  options: [
    { value: 'server_assigns', label: 'The server assigns it', provenance: 'heuristic', resolvedOrigin: 'server_generated' },
    { value: 'caller_assigns', label: 'The caller chooses it', provenance: 'heuristic', resolvedOrigin: 'caller_supplied' },
  ],
};

function candidate(over: Partial<TriageCandidate> = {}): TriageCandidate {
  return {
    id: 'q1',
    question: 'Who assigns body.id on add_pet?',
    tool: 'add_pet',
    actionPath: '/pet',
    fieldPath: 'body.id',
    answerSpec,
    envelopes: [{ id: 'spec_field', kind: 'spec_field', text: SPEC_TEXT }],
    ...over,
  };
}

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
};

function verdicts(...list: unknown[]) {
  return new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: 'text' as const, text: JSON.stringify({ verdicts: list }) }],
      finishReason: { unified: 'stop' as const, raw: undefined },
      usage: USAGE,
      warnings: [],
    },
  });
}

const run = (model: MockLanguageModelV4, candidates = [candidate()]) =>
  triageQuestions({ candidates, enrichmentComplete: true, model });

describe('triageQuestions accepts a verdict that survives every check', () => {
  it('retires a question whose answer is quoted verbatim from the field’s own description', async () => {
    const result = await run(
      verdicts({
        questionId: 'q1',
        verdict: 'answered_by_evidence',
        evidenceSource: 'spec_field',
        evidenceQuote: REAL_QUOTE,
        assumedAnswer: 'server_assigns',
      }),
    );
    expect(result.assumptions).toHaveLength(1);
    expect(result.assumptions[0]).toMatchObject({ id: 'q1', answer: 'server_assigns', sourceKind: 'spec_field' });
    expect(result.rejections).toEqual([]);
  });

  it('carries the source url through for a documentation quote', async () => {
    // The page has to name the operation for a sentence in it to bear on this
    // question — see the bare-leaf case below for why that matters.
    const docText = 'POST /pet: the id is assigned by the server on creation and any value supplied is ignored.';
    const result = await run(
      verdicts({
        questionId: 'q1',
        verdict: 'answered_by_evidence',
        evidenceSource: 'docs:0',
        evidenceQuote: 'the id is assigned by the server on creation and any value supplied is ignored',
        assumedAnswer: 'server_assigns',
      }),
      [candidate({ envelopes: [{ id: 'docs:0', kind: 'docs', text: docText, url: 'https://petstore.test/docs/pets' }] })],
    );
    expect(result.assumptions[0].sourceUrl).toBe('https://petstore.test/docs/pets');
  });

  it('does not let a bare "id" leaf anchor relevance on its own', async () => {
    // Two-character leaves are excluded from the relevance anchor deliberately:
    // "id" occurs in almost any prose, so allowing it would make the anchor free
    // to satisfy for exactly the field names that are most ambiguous.
    const docText = 'Every id in this API is assigned by the server on creation and any value supplied is ignored.';
    const result = await run(
      verdicts({
        questionId: 'q1',
        verdict: 'answered_by_evidence',
        evidenceSource: 'docs:0',
        evidenceQuote: 'is assigned by the server on creation and any value supplied is ignored',
        assumedAnswer: 'server_assigns',
      }),
      [candidate({ envelopes: [{ id: 'docs:0', kind: 'docs', text: docText, url: 'https://x.test' }] })],
    );
    expect(result.assumptions).toEqual([]);
    expect(result.rejections[0].reason).toContain('not about this field or operation');
  });
});

describe('triageQuestions refuses a verdict that fails any check', () => {
  const reasonOf = (r: Awaited<ReturnType<typeof run>>) => r.rejections[0]?.reason ?? '';

  it('refuses a fabricated quote', async () => {
    const result = await run(
      verdicts({
        questionId: 'q1',
        verdict: 'answered_by_evidence',
        evidenceSource: 'spec_field',
        evidenceQuote: 'The server assigns this during the nightly reconciliation job.',
        assumedAnswer: 'server_assigns',
      }),
    );
    expect(result.assumptions).toEqual([]);
    expect(reasonOf(result)).toContain('does not appear');
  });

  it('refuses a real quote cited against the wrong evidence', async () => {
    const result = await run(
      verdicts({
        questionId: 'q1',
        verdict: 'answered_by_evidence',
        evidenceSource: 'docs:0',
        evidenceQuote: REAL_QUOTE,
        assumedAnswer: 'server_assigns',
      }),
      [
        candidate({
          envelopes: [
            { id: 'spec_field', kind: 'spec_field', text: SPEC_TEXT },
            { id: 'docs:0', kind: 'docs', text: 'Unrelated page about body.id rate limits.', url: 'https://x.test' },
          ],
        }),
      ],
    );
    expect(result.assumptions).toEqual([]);
    expect(reasonOf(result)).toContain('does not appear in "docs:0"');
  });

  it('refuses evidence that is not about this field or operation', async () => {
    const irrelevant = 'Webhook deliveries are assigned by the server on creation and any value supplied is ignored.';
    const result = await run(
      verdicts({
        questionId: 'q1',
        verdict: 'answered_by_evidence',
        evidenceSource: 'docs:0',
        evidenceQuote: 'assigned by the server on creation and any value supplied is ignored',
        assumedAnswer: 'server_assigns',
      }),
      [candidate({ envelopes: [{ id: 'docs:0', kind: 'docs', text: irrelevant, url: 'https://x.test' }] })],
    );
    expect(result.assumptions).toEqual([]);
    expect(reasonOf(result)).toContain('not about this field or operation');
  });

  it('refuses an answer the question never offered', async () => {
    // Without this the model could introduce a meaning the archetype never
    // defined, and finalize would have nothing to resolve it against.
    const result = await run(
      verdicts({
        questionId: 'q1',
        verdict: 'answered_by_evidence',
        evidenceSource: 'spec_field',
        evidenceQuote: REAL_QUOTE,
        assumedAnswer: 'the_server_does_it_probably',
      }),
    );
    expect(result.assumptions).toEqual([]);
    expect(reasonOf(result)).toContain('not one of this question');
  });

  it('refuses a verdict about a question that was not in the batch', async () => {
    const result = await run(
      verdicts({
        questionId: 'q-invented',
        verdict: 'answered_by_evidence',
        evidenceSource: 'spec_field',
        evidenceQuote: REAL_QUOTE,
        assumedAnswer: 'server_assigns',
      }),
    );
    expect(result.assumptions).toEqual([]);
    expect(reasonOf(result)).toContain('was not in this batch');
  });

  it('ignores a keep verdict entirely', async () => {
    const result = await run(verdicts({ questionId: 'q1', verdict: 'keep' }));
    expect(result.assumptions).toEqual([]);
    expect(result.rejections).toEqual([]);
  });
});

describe('triageQuestions circuit breakers', () => {
  it('declines to run at all on a partial reading of the API', async () => {
    // Suppressing on incomplete evidence is exactly when we would be wrong.
    const model = verdicts({
      questionId: 'q1',
      verdict: 'answered_by_evidence',
      evidenceSource: 'spec_field',
      evidenceQuote: REAL_QUOTE,
      assumedAnswer: 'server_assigns',
    });
    const result = await triageQuestions({ candidates: [candidate()], enrichmentComplete: false, model });
    expect(result.skipped).toBe('partial_picture');
    expect(result.assumptions).toEqual([]);
    expect(model.doGenerateCalls).toHaveLength(0); // no call spent either
  });

  it('spends no call when nothing has evidence attached', async () => {
    const model = verdicts();
    const result = await triageQuestions({
      candidates: [candidate({ envelopes: [] })],
      enrichmentComplete: true,
      model,
    });
    expect(result.skipped).toBe('nothing_to_judge');
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it('never retires more than a fraction of a batch', async () => {
    expect(retirementCap(1)).toBe(1);
    expect(retirementCap(3)).toBe(2);
    expect(retirementCap(13)).toBe(6);
    expect(retirementCap(100)).toBe(6);

    // Ten questions all "answered" by a planted description: the cap holds and
    // the rest stay standing.
    const candidates = Array.from({ length: 10 }, (_, i) => candidate({ id: `q${i}` }));
    const model = verdicts(
      ...candidates.map((c) => ({
        questionId: c.id,
        verdict: 'answered_by_evidence',
        evidenceSource: 'spec_field',
        evidenceQuote: REAL_QUOTE,
        assumedAnswer: 'server_assigns',
      })),
    );
    const result = await triageQuestions({ candidates, enrichmentComplete: true, model });
    expect(result.assumptions).toHaveLength(retirementCap(10));
    expect(result.rejections.every((r) => r.reason.includes('cap'))).toBe(true);
  });

  it('leaves every question standing when the model errors', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error('gateway unavailable');
      },
    });
    const result = await triageQuestions({ candidates: [candidate()], enrichmentComplete: true, model });
    expect(result.assumptions).toEqual([]);
    expect(result.considered).toBe(1);
  });
});

describe('triage prompt discipline', () => {
  it('sends structured data, never interpolated prose', async () => {
    const model = verdicts({ questionId: 'q1', verdict: 'keep' });
    await run(model);
    const call = model.doGenerateCalls[0];
    const userMessage = JSON.stringify(call.prompt);
    // The whole payload is a JSON document; untrusted text only ever appears as
    // a quoted string value, which is the delimiting strategy deepEnrich uses.
    expect(userMessage).toContain('questionId');
    expect(userMessage).toContain('evidence');
  });

  it('names the data-not-instructions rule in the system message', async () => {
    const model = verdicts({ questionId: 'q1', verdict: 'keep' });
    await run(model);
    const system = JSON.stringify(model.doGenerateCalls[0].prompt);
    expect(system).toContain('DATA');
    expect(system).toContain('ignore previous instructions');
  });
});
