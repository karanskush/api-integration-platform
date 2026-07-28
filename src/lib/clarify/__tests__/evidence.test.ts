import { describe, expect, it } from 'vitest';
import {
  buildEnvelopes,
  isRelevant,
  MAX_QUOTE_CHARS,
  MIN_QUOTE_CHARS,
  normalizeForMatch,
  verifyQuote,
  type EvidenceEnvelope,
} from '../evidence';

const env = (over: Partial<EvidenceEnvelope> = {}): EvidenceEnvelope => ({
  id: 'spec_field',
  kind: 'spec_field',
  text: 'The identifier is assigned by the server on creation and any value supplied by the caller is ignored.',
  ...over,
});

const REAL_QUOTE = 'assigned by the server on creation and any value supplied by the caller is ignored';

describe('normalizeForMatch', () => {
  it('folds the typographic variants a model silently corrects', () => {
    expect(normalizeForMatch('The “server’s” value')).toBe(normalizeForMatch("the \"server's\" value"));
    expect(normalizeForMatch('non breaking   space')).toBe('non breaking space');
    expect(normalizeForMatch('en–dash and em—dash')).toBe('en-dash and em-dash');
  });

  it('drops the truncation sentinel asData appends', () => {
    // Otherwise a quote spanning a truncation boundary never matches.
    expect(normalizeForMatch('the value is set by the serv…')).toBe('the value is set by the serv');
  });
});

describe('verifyQuote', () => {
  it('accepts a quote that really is in the named envelope', () => {
    const result = verifyQuote(REAL_QUOTE, 'spec_field', [env()]);
    expect(result.ok).toBe(true);
  });

  it('accepts a quote the model wrapped in its own punctuation', () => {
    const result = verifyQuote(`"${REAL_QUOTE}."`, 'spec_field', [env()]);
    expect(result.ok).toBe(true);
  });

  // The property that does the real work. A 24 KB context contains something
  // resembling almost any plausible sentence, so the model has to say which
  // single piece of evidence it read.
  it('rejects a real quote attributed to the wrong envelope', () => {
    const envelopes = [
      env(),
      { id: 'docs:0', kind: 'docs' as const, text: 'Unrelated page about webhooks and retry policy.', url: 'https://x.test/webhooks' },
    ];
    const result = verifyQuote(REAL_QUOTE, 'docs:0', envelopes);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('does not appear in "docs:0"');
  });

  it('rejects a fluent sentence that appears nowhere', () => {
    const result = verifyQuote('The server assigns this value during the nightly reconciliation job.', 'spec_field', [env()]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('does not appear');
  });

  it('rejects an envelope the model was never given', () => {
    const result = verifyQuote(REAL_QUOTE, 'docs:7', [env()]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('was not supplied');
  });

  it('rejects a quote too short to mean anything', () => {
    // "is assigned by" is true of half the corpus by luck.
    const result = verifyQuote('is assigned', 'spec_field', [env()]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain(`shorter than ${MIN_QUOTE_CHARS}`);
  });

  it('rejects a quote long enough to be a paragraph rather than a citation', () => {
    const long = 'x'.repeat(MAX_QUOTE_CHARS + 1);
    const result = verifyQuote(long, 'spec_field', [env({ text: long })]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain(`longer than ${MAX_QUOTE_CHARS}`);
  });

  it('rejects a missing quote or a missing source', () => {
    expect(verifyQuote(undefined, 'spec_field', [env()]).ok).toBe(false);
    expect(verifyQuote('   ', 'spec_field', [env()]).ok).toBe(false);
    expect(verifyQuote(REAL_QUOTE, undefined, [env()]).ok).toBe(false);
  });

  it('matches across whitespace the model re-flowed', () => {
    const reflowed = REAL_QUOTE.replace(/ /g, '\n   ');
    expect(verifyQuote(reflowed, 'spec_field', [env()]).ok).toBe(true);
  });
});

describe('isRelevant', () => {
  it('always accepts the field’s own description', () => {
    expect(isRelevant(env(), 'body.id', 'add_pet', '/pet')).toBe(true);
  });

  it('requires a sibling or doc envelope to mention the field or the operation', () => {
    const doc = (text: string): EvidenceEnvelope => ({ id: 'docs:0', kind: 'docs', text, url: 'https://x.test' });

    expect(isRelevant(doc('The petId path parameter accepts the id returned by POST /pet.'), 'path.petId', 'get_pet_by_id', '/pet/{petId}')).toBe(true);
    expect(isRelevant(doc('Rate limits are 100 requests per minute per token.'), 'path.petId', 'get_pet_by_id', '/pet/{petId}')).toBe(false);
  });

  it('matches on the leaf name, not only the full path', () => {
    const doc: EvidenceEnvelope = { id: 'docs:0', kind: 'docs', text: 'The userStatus field encodes account state.', url: 'https://x.test' };
    expect(isRelevant(doc, 'body.userStatus', 'create_user', '/user')).toBe(true);
  });
});

describe('buildEnvelopes', () => {
  it('names each piece of evidence so exactly one can be cited', () => {
    const envelopes = buildEnvelopes({
      fieldDescription: 'The identifier of the pet, assigned on creation by the server itself.',
      actionDescription: 'Add a new pet to the store',
      siblingDescriptions: [{ field: 'body.name', description: 'The name of the pet' }],
      docs: [
        { url: 'https://petstore.test/docs/pets', title: 'Pets', excerpt: 'Creating a pet returns the assigned id.' },
        { url: 'https://petstore.test/docs/tags', excerpt: 'Tags are free-form labels.' },
      ],
    });
    expect(envelopes.map((e) => e.id)).toEqual(['spec_field', 'spec_sibling', 'docs:0', 'docs:1']);
    expect(envelopes.find((e) => e.id === 'docs:0')?.url).toBe('https://petstore.test/docs/pets');
  });

  it('omits envelopes with nothing in them rather than emitting empty ones', () => {
    expect(buildEnvelopes({})).toEqual([]);
    expect(buildEnvelopes({ fieldDescription: '   ' })).toEqual([]);
  });

  it('sanitizes third-party text before it can reach a prompt or a stored quote', () => {
    // Escapes rather than literals: a raw control character is invisible in
    // review and makes git treat the whole file as binary.
    const envelopes = buildEnvelopes({ fieldDescription: 'has a\u0000control\u0007char\u001Fhere' });
    expect(envelopes[0].text).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/);
    expect(envelopes[0].text).toBe('has a control char here');
  });
});
