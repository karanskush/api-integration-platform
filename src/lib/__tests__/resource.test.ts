import { describe, expect, it } from 'vitest';
import {
  collectionPathFor,
  isGenericFieldName,
  isIdLike,
  normalizeFieldName,
  pathResources,
  resourceFromFieldName,
  resourceOf,
  singularize,
  tokenize,
} from '../resource';

describe('tokenize', () => {
  it('splits camelCase, snake_case, and kebab-case identically', () => {
    expect(tokenize('customerId')).toEqual(['customer', 'id']);
    expect(tokenize('customer_id')).toEqual(['customer', 'id']);
    expect(tokenize('customer-id')).toEqual(['customer', 'id']);
    expect(tokenize('CustomerId')).toEqual(['customer', 'id']);
  });

  it('handles acronym runs', () => {
    expect(tokenize('APIKey')).toEqual(['api', 'key']);
    expect(tokenize('customerAPIKey')).toEqual(['customer', 'api', 'key']);
  });

  it('keeps digits attached to their word', () => {
    expect(tokenize('res0Id')).toEqual(['res0', 'id']);
    expect(tokenize('address2')).toEqual(['address2']);
  });

  it('returns an empty list for a nameless input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('___')).toEqual([]);
  });
});

describe('normalizeFieldName', () => {
  it('collapses every naming style to one comparison key', () => {
    const expected = 'customer_id';
    for (const name of ['customerId', 'customer_id', 'Customer-Id', 'CUSTOMER_ID']) {
      expect(normalizeFieldName(name)).toBe(expected);
    }
  });
});

describe('isIdLike', () => {
  // The bug this replaced: the old regex required a separator before the id
  // token, so `customer_id` matched and `customerId` silently did not — every
  // camelCase API's identifiers went untraced.
  it('recognises camelCase identifiers', () => {
    expect(isIdLike('customerId')).toBe(true);
    expect(isIdLike('petId')).toBe(true);
    expect(isIdLike('externalRef')).toBe(true);
    expect(isIdLike('pageToken')).toBe(true);
  });

  it('still recognises snake_case and bare identifiers', () => {
    expect(isIdLike('customer_id')).toBe(true);
    expect(isIdLike('id')).toBe(true);
    expect(isIdLike('uuid')).toBe(true);
    expect(isIdLike('slug')).toBe(true);
  });

  it('does not treat ordinary fields as identifiers', () => {
    for (const name of ['email', 'name', 'description', 'amount', 'createdAt', 'identity']) {
      expect(isIdLike(name)).toBe(false);
    }
  });

  it('is false for an empty name', () => {
    expect(isIdLike('')).toBe(false);
  });
});

describe('resourceFromFieldName', () => {
  it('extracts the resource a foreign key points at', () => {
    expect(resourceFromFieldName('customerId')).toBe('customer');
    expect(resourceFromFieldName('customer_id')).toBe('customer');
    expect(resourceFromFieldName('invoiceItemsId')).toBe('invoice_item');
  });

  it('returns null for a bare identifier, which points at nothing on its own', () => {
    expect(resourceFromFieldName('id')).toBeNull();
    expect(resourceFromFieldName('uuid')).toBeNull();
  });

  it('returns null for a non-identifier', () => {
    expect(resourceFromFieldName('emailAddress')).toBeNull();
  });
});

describe('singularize', () => {
  it('handles the common plural forms', () => {
    expect(singularize('pets')).toBe('pet');
    expect(singularize('companies')).toBe('company');
    expect(singularize('addresses')).toBe('address');
    expect(singularize('boxes')).toBe('box');
  });

  // Nouns that merely end in s must survive, or the resource name they produce
  // matches nothing downstream.
  it('leaves singular nouns ending in s alone', () => {
    expect(singularize('status')).toBe('status');
    expect(singularize('analysis')).toBe('analysis');
    expect(singularize('address')).toBe('address');
  });
});

describe('pathResources', () => {
  it('lists the resource nouns a REST path mentions', () => {
    expect(pathResources('/v1/customers/{customerId}/invoices')).toEqual(['customer', 'invoice']);
  });

  it('ignores version and transport segments', () => {
    expect(pathResources('/v2/api/orders')).toEqual(['order']);
    expect(pathResources('/rest/v1/items')).toEqual(['item']);
  });

  // Slack-style RPC paths carry the resource in a dotted segment, not a path
  // segment — without this the whole affinity signal is blind to them.
  it('splits dotted RPC segments', () => {
    expect(pathResources('/api/conversations.list')).toContain('conversation');
    expect(pathResources('/api/chat.postMessage')).toContain('chat');
  });

  it('skips path parameters', () => {
    expect(pathResources('/{tenantId}/things')).toEqual(['thing']);
  });

  it('returns an empty list for a root path', () => {
    expect(pathResources('/')).toEqual([]);
  });
});

describe('collectionPathFor / resourceOf', () => {
  it('finds the collection an identifier addresses an item within', () => {
    expect(collectionPathFor('/v1/pets/{petId}', 'petId')).toBe('/v1/pets');
    expect(collectionPathFor('/v1/pets/{petId}/toys/{toyId}', 'toyId')).toBe('/v1/pets/{petId}/toys');
  });

  it('returns null when the parameter is not in the path', () => {
    expect(collectionPathFor('/v1/pets', 'petId')).toBeNull();
  });

  it('names the resource from a collection path', () => {
    expect(resourceOf('/v1/pets')).toBe('pet');
    expect(resourceOf('/v1/pets/{petId}/toys')).toBe('toy');
  });
});

describe('isGenericFieldName', () => {
  // The stoplist is what stops `id` on one resource linking to `id` on an
  // unrelated one — the edge class that gets an agent to act on the wrong object.
  it('flags names too common to identify anything on their own', () => {
    for (const name of ['id', 'name', 'status', 'data', 'url', 'code', 'total', 'metadata']) {
      expect(isGenericFieldName(name)).toBe(true);
    }
  });

  it('does not flag a distinctive name', () => {
    for (const name of ['customer_id', 'username', 'stripe_account', 'channel_id']) {
      expect(isGenericFieldName(name)).toBe(false);
    }
  });
});
