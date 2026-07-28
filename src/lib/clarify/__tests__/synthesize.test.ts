import { describe, expect, it } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { synthesizeMappings, type SynthesisCandidate } from '../synthesize';

const DOC_TEXT =
  'The userStatus field on /user encodes account state: 1 means the account is active and 2 means it is suspended.';
const DOC_QUOTE = '1 means the account is active and 2 means it is suspended';

function candidate(over: Partial<SynthesisCandidate> = {}): SynthesisCandidate {
  return {
    id: 'q1',
    question: 'What do the values of body.userStatus mean?',
    tool: 'create_user',
    actionPath: '/user',
    fieldPath: 'body.userStatus',
    fieldType: 'integer',
    fieldDescription: 'User Status',
    envelopes: [{ id: 'docs:0', kind: 'docs', text: DOC_TEXT, url: 'https://petstore.test/docs/users' }],
    ...over,
  };
}

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
};

function mappings(...list: unknown[]) {
  return new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: 'text' as const, text: JSON.stringify({ mappings: list }) }],
      finishReason: { unified: 'stop' as const, raw: undefined },
      usage: USAGE,
      warnings: [],
    },
  });
}

const run = (model: MockLanguageModelV4, candidates = [candidate()]) => synthesizeMappings({ candidates, model });

describe('synthesizeMappings', () => {
  it('keeps a documented mapping backed by a real quote', async () => {
    const result = await run(
      mappings(
        { questionId: 'q1', value: '1', meaning: 'active', basis: 'documented', evidenceSource: 'docs:0', evidenceQuote: DOC_QUOTE },
        { questionId: 'q1', value: '2', meaning: 'suspended', basis: 'documented', evidenceSource: 'docs:0', evidenceQuote: DOC_QUOTE },
      ),
    );
    const suggested = result.suggestions.get('q1')!;
    expect(suggested).toHaveLength(2);
    expect(suggested.every((s) => s.provenance === 'docs')).toBe(true);
    expect(suggested[0].sourceUrl).toBe('https://petstore.test/docs/users');
  });

  it('labels a convention-based mapping as a guess', async () => {
    const result = await run(mappings({ questionId: 'q1', value: '1', meaning: 'active', basis: 'convention' }));
    expect(result.suggestions.get('q1')![0].provenance).toBe('model_guess');
  });

  // The important one: a claim of documentation that the evidence does not
  // support is not thrown away, it is demoted. The mapping may still be a
  // perfectly reasonable guess — it just stops claiming to be a finding.
  it('demotes an unsupported documented claim to a guess rather than trusting it', async () => {
    const result = await run(
      mappings({
        questionId: 'q1',
        value: '3',
        meaning: 'pending review',
        basis: 'documented',
        evidenceSource: 'docs:0',
        evidenceQuote: '3 means the account is pending manual review by staff',
      }),
    );
    const suggested = result.suggestions.get('q1')!;
    expect(suggested).toHaveLength(1);
    expect(suggested[0].provenance).toBe('model_guess');
    expect(result.rejections[0].reason).toContain('demoted to a guess');
  });

  it('demotes a real quote that is about a different field', async () => {
    const unrelated = 'Rate limiting returns 1 for allowed and 2 for throttled on every endpoint we serve.';
    const result = await run(
      mappings({
        questionId: 'q1',
        value: '1',
        meaning: 'allowed',
        basis: 'documented',
        evidenceSource: 'docs:0',
        evidenceQuote: 'returns 1 for allowed and 2 for throttled on every endpoint we serve',
      }),
      [candidate({ envelopes: [{ id: 'docs:0', kind: 'docs', text: unrelated, url: 'https://x.test' }] })],
    );
    expect(result.suggestions.get('q1')![0].provenance).toBe('model_guess');
  });

  it('sorts what we can stand behind ahead of what we cannot', async () => {
    const result = await run(
      mappings(
        { questionId: 'q1', value: '9', meaning: 'archived', basis: 'convention' },
        { questionId: 'q1', value: '1', meaning: 'active', basis: 'documented', evidenceSource: 'docs:0', evidenceQuote: DOC_QUOTE },
      ),
    );
    expect(result.suggestions.get('q1')!.map((s) => s.provenance)).toEqual(['docs', 'model_guess']);
  });

  it('bounds guesses, because a long shortlist is slower to audit than a blank widget', async () => {
    const result = await run(
      mappings(
        { questionId: 'q1', value: '1', meaning: 'a', basis: 'convention' },
        { questionId: 'q1', value: '2', meaning: 'b', basis: 'convention' },
        { questionId: 'q1', value: '3', meaning: 'c', basis: 'convention' },
        { questionId: 'q1', value: '4', meaning: 'd', basis: 'convention' },
      ),
    );
    expect(result.suggestions.get('q1')).toHaveLength(2);
    expect(result.rejections.some((r) => r.reason.includes('guesses'))).toBe(true);
  });

  it('ignores a mapping for a field that was not in the batch', async () => {
    const result = await run(mappings({ questionId: 'q-invented', value: '1', meaning: 'active', basis: 'convention' }));
    expect(result.suggestions.size).toBe(0);
    expect(result.rejections[0].reason).toContain('not in this batch');
  });

  it('drops a mapping missing a value or a meaning', async () => {
    const result = await run(
      mappings(
        { questionId: 'q1', value: '  ', meaning: 'active', basis: 'convention' },
        { questionId: 'q1', value: '1', meaning: '   ', basis: 'convention' },
      ),
    );
    expect(result.suggestions.size).toBe(0);
    expect(result.rejections).toHaveLength(2);
  });

  it('falls back to an empty widget when the model errors', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error('gateway unavailable');
      },
    });
    const result = await synthesizeMappings({ candidates: [candidate()], model });
    expect(result.suggestions.size).toBe(0);
  });

  it('spends no call when there is nothing to synthesize', async () => {
    const model = mappings();
    await synthesizeMappings({ candidates: [], model });
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it('names the data-not-instructions rule in the system message', async () => {
    const model = mappings({ questionId: 'q1', value: '1', meaning: 'active', basis: 'convention' });
    await run(model);
    const sent = JSON.stringify(model.doGenerateCalls[0].prompt);
    expect(sent).toContain('DATA');
    expect(sent).toContain('ignore previous instructions');
  });
});
