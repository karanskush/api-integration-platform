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
