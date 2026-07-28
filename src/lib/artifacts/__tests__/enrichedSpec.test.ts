import { describe, expect, it } from 'vitest';
import { petstoreActions, record } from '../../advisor/__tests__/fixtures';
import { buildEnrichedSpec } from '../enrichedSpec';

describe('buildEnrichedSpec', () => {
  it('produces an openapi-shaped document with one path entry per action path', () => {
    const r = record({ actions: petstoreActions() });
    const doc = buildEnrichedSpec(r) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.paths['/v1/pets']).toBeDefined();
    expect(doc.paths['/v1/pets/{petId}']).toBeDefined();
  });

  it('tags a produced-by-api field with its origin and known producer', () => {
    const r = record({ actions: petstoreActions() });
    const doc = buildEnrichedSpec(r) as { paths: Record<string, Record<string, any>> };
    const getPet = doc.paths['/v1/pets/{petId}'].get;
    const petId = getPet.requestFields['path.petId'];
    expect(petId['x-spotcheck-origin']).toBe('produced_by_api');
    expect(petId['x-spotcheck-produced-by'].length).toBeGreaterThan(0);
    expect(petId['x-spotcheck-human-verified']).toBe(false);
  });

  it('marks a field as human-verified when it appears in the verified set', () => {
    const r = record({ actions: petstoreActions() });
    const doc = buildEnrichedSpec(r, new Set(['get_pet path.petId'])) as { paths: Record<string, Record<string, any>> };
    const petId = doc.paths['/v1/pets/{petId}'].get.requestFields['path.petId'];
    expect(petId['x-spotcheck-human-verified']).toBe(true);
  });

  // The whole point of asking. Before this, an answer only flipped
  // human-verified to true while x-spotcheck-origin stayed heuristic — so an
  // owner could correct us and the published spec would keep the wrong claim,
  // now stamped as confirmed by them.
  describe('a human answer outranks the heuristic', () => {
    const petIdOf = (input?: Parameters<typeof buildEnrichedSpec>[1]) => {
      const doc = buildEnrichedSpec(record({ actions: petstoreActions() }), input) as {
        paths: Record<string, Record<string, any>>;
      };
      return doc.paths['/v1/pets/{petId}'].get.requestFields['path.petId'];
    };

    it('rewrites the origin and says the answer came from a human', () => {
      const before = petIdOf();
      expect(before['x-spotcheck-origin']).toBe('produced_by_api');
      expect(before['x-spotcheck-origin-source']).toBe('heuristic');

      const after = petIdOf({ answers: new Map([['get_pet path.petId', { origin: 'caller_supplied' as const }]]) });
      expect(after['x-spotcheck-origin']).toBe('caller_supplied');
      expect(after['x-spotcheck-origin-source']).toBe('human');
      expect(after['x-spotcheck-human-verified']).toBe(true);
    });

    it('still marks a field verified when the answer resolved to no origin', () => {
      // Confirming a date format or a PUT's merge semantics verifies the field
      // without reclassifying where its value comes from.
      const field = petIdOf({ answers: new Map([['get_pet path.petId', {}]]) });
      expect(field['x-spotcheck-human-verified']).toBe(true);
      expect(field['x-spotcheck-origin']).toBe('produced_by_api'); // unchanged
      expect(field['x-spotcheck-origin-source']).toBe('heuristic');
    });

    it('records a skipped question as unresolved rather than silently dropping it', () => {
      const asked = petIdOf({ unresolved: new Set(['get_pet path.petId']) });
      expect(asked['x-spotcheck-unresolved']).toBe(true);
      expect(asked['x-spotcheck-human-verified']).toBe(false);

      // Never asked is not the same as asked-and-unanswerable.
      expect(petIdOf()['x-spotcheck-unresolved']).toBeUndefined();
    });

    it('withholds a disputed producer and reclassifies what remains', () => {
      const before = petIdOf();
      const producers: Array<{ operation: string; field: string }> = before['x-spotcheck-produced-by'];
      expect(producers.length).toBeGreaterThan(0);

      const all = new Set(producers.map((p) => `get_pet path.petId ${p.operation}.${p.field}`));
      const after = petIdOf({ disputed: all });
      expect(after['x-spotcheck-produced-by']).toBeUndefined();
      // With every producer withheld, produced_by_api no longer holds.
      expect(after['x-spotcheck-origin']).not.toBe('produced_by_api');
    });

    it('applies an assumption but never lets it claim a human confirmed it', () => {
      const field = petIdOf({
        assumptions: new Map([
          [
            'get_pet path.petId',
            {
              origin: 'caller_supplied' as const,
              quote: 'callers supply the pet identifier themselves',
              sourceKind: 'docs',
              sourceUrl: 'https://petstore.test/docs',
            },
          ],
        ]),
      });
      expect(field['x-spotcheck-origin']).toBe('caller_supplied');
      expect(field['x-spotcheck-origin-source']).toBe('assumed');
      // The line that matters: evidence is not confirmation.
      expect(field['x-spotcheck-human-verified']).toBe(false);
      // And it carries its receipt, so a consumer can judge the inference.
      expect(field['x-spotcheck-assumed']).toEqual({
        quote: 'callers supply the pet identifier themselves',
        source: 'docs',
        url: 'https://petstore.test/docs',
      });
    });

    it('lets a person override an assumption about the same field', () => {
      const field = petIdOf({
        answers: new Map([['get_pet path.petId', { origin: 'server_generated' as const }]]),
        assumptions: new Map([
          ['get_pet path.petId', { origin: 'caller_supplied' as const, quote: 'q'.repeat(30), sourceKind: 'docs' }],
        ]),
      });
      expect(field['x-spotcheck-origin']).toBe('server_generated');
      expect(field['x-spotcheck-origin-source']).toBe('human');
      expect(field['x-spotcheck-human-verified']).toBe(true);
      expect(field['x-spotcheck-assumed']).toBeUndefined();
    });

    it('keeps accepting the legacy set of verified keys', () => {
      const field = petIdOf(new Set(['get_pet path.petId']));
      expect(field['x-spotcheck-human-verified']).toBe(true);
    });
  });

  it('excludes container fields but keeps leaf fields', () => {
    const r = record({ actions: petstoreActions() });
    const doc = buildEnrichedSpec(r) as { paths: Record<string, Record<string, any>> };
    const createPet = doc.paths['/v1/pets'].post;
    const fieldPaths = Object.keys(createPet.requestFields);
    expect(fieldPaths).toContain('body.name');
    expect(fieldPaths).not.toContain('body'); // the container itself is not a leaf
  });

  it('carries operationId, description, and safety on each operation entry', () => {
    const r = record({ actions: petstoreActions() });
    const doc = buildEnrichedSpec(r) as { paths: Record<string, Record<string, any>> };
    const createPet = doc.paths['/v1/pets'].post;
    expect(createPet.operationId).toBe('create_pet');
    expect(createPet['x-spotcheck-safety']).toBe('write');
  });
});
