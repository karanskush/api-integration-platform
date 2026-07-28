import { describe, expect, it } from 'vitest';
import { MAX_VALUE_PAIRS, resolveAnswer } from '../answers';
import type { AnswerSpec } from '../archetypes';

const spec = (over: Partial<AnswerSpec> = {}): AnswerSpec => ({
  kind: 'single_choice',
  allowOther: true,
  options: [
    { value: 'server_assigns', label: 'The server assigns it', provenance: 'heuristic', resolvedOrigin: 'server_generated' },
    { value: 'caller_assigns', label: 'The caller chooses it', provenance: 'heuristic', resolvedOrigin: 'caller_supplied' },
  ],
  ...over,
});

const reason = (r: ReturnType<typeof resolveAnswer>) => ('reason' in r ? r.reason : null);
const answer = (r: ReturnType<typeof resolveAnswer>) => ('answer' in r ? r.answer : null);

describe('resolveAnswer', () => {
  it('accepts a choice that is one of the recorded options', () => {
    expect(answer(resolveAnswer(spec(), { choice: 'server_assigns' }))).toBe('server_assigns');
  });

  // The reason this validator exists: finalize reads the stored answer to decide
  // what the published spec claims, so a value the question never offered must
  // never reach the column.
  it('rejects a choice the question never offered', () => {
    expect(reason(resolveAnswer(spec(), { choice: 'server_generated_lol' }))).toContain('not one of');
  });

  it('rejects a choice when the question recorded no options at all', () => {
    expect(reason(resolveAnswer(null, { choice: 'anything' }))).toContain('no recorded options');
  });

  it('matches on the stable value, not the label the browser saw', () => {
    // Option text never round-trips through the client, so submitting the label
    // is not a valid answer.
    expect(reason(resolveAnswer(spec(), { choice: 'The server assigns it' }))).toContain('not one of');
  });

  it('demands exactly one mode', () => {
    expect(reason(resolveAnswer(spec(), {}))).toContain('exactly one');
    expect(reason(resolveAnswer(spec(), { choice: 'server_assigns', other: 'also this' }))).toContain('exactly one');
  });

  describe('the free-text escape hatch', () => {
    it('accepts and sanitizes text', () => {
      expect(answer(resolveAnswer(spec(), { other: '  the server  overwrites  it  ' }))).toEqual({
        other: 'the server overwrites it',
      });
    });

    it('strips control characters before the value is ever stored', () => {
      // The answer flows into the enriched-spec artifact other tools parse, so
      // the boundary that matters is the write, not the render. Written as
      // escapes for the same reason fieldKey's separator is: a literal control
      // character is invisible in review and makes git treat the file as binary.
      const smuggled = 'plain\u0000value\u0007with\u001Fcontrols';
      const result = answer(resolveAnswer(spec(), { other: smuggled })) as { other: string };
      expect(result.other).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/);
      expect(result.other).toBe('plain value with controls');
    });

    it('rejects text that is empty once sanitized', () => {
      // Whitespace and control characters alike sanitize away to nothing.
      expect(reason(resolveAnswer(spec(), { other: '  \u0000  \u0009 ' }))).toContain('empty');
    });

    it('honours a question that does not allow free text', () => {
      expect(reason(resolveAnswer(spec({ allowOther: false }), { other: 'nope' }))).toContain('does not accept');
    });
  });

  describe('value/meaning pairs', () => {
    const pairSpec = spec({ kind: 'open_values', options: [] });

    it('accepts scalar codes with meanings', () => {
      expect(
        answer(
          resolveAnswer(pairSpec, {
            values: [
              { value: 1, meaning: 'active' },
              { value: '2', meaning: 'suspended' },
            ],
          }),
        ),
      ).toEqual({
        values: [
          { value: '1', meaning: 'active' },
          { value: '2', meaning: 'suspended' },
        ],
      });
    });

    it('rejects a pair with no meaning, which would record a code and say nothing', () => {
      expect(reason(resolveAnswer(pairSpec, { values: [{ value: 1, meaning: '  ' }] }))).toContain('meaning');
    });

    it('rejects a non-scalar code', () => {
      expect(reason(resolveAnswer(pairSpec, { values: [{ value: { nested: true }, meaning: 'x' }] }))).toContain('scalar');
    });

    it('bounds the list', () => {
      const tooMany = Array.from({ length: MAX_VALUE_PAIRS + 1 }, (_, i) => ({ value: i, meaning: `m${i}` }));
      expect(reason(resolveAnswer(pairSpec, { values: tooMany }))).toContain('cannot exceed');
      expect(reason(resolveAnswer(pairSpec, { values: [] }))).toContain('empty');
    });
  });
});
