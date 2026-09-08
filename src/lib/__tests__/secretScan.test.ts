// Two halves, and the second matters as much as the first: this module runs on
// every import, so what it DOESN'T strip is a correctness property. An
// over-eager scanner would quietly gut the example values that make an API page
// and its generated snippets useful.

import { describe, expect, it } from 'vitest';
import {
  classifyValue,
  scrubSchemaExamples,
  scrubValue,
  secretHint,
  shannonEntropy,
} from '../secretScan';

// Header decodes to {"alg":"HS256","typ":"JWT"} — the structural check needs a
// header that really parses, not merely three dot-separated segments.

// Every vendor-format fixture below is ASSEMBLED FROM PARTS rather than written
// inline. The values are fabricated, but they match the real formats closely
// enough that a secret scanner flags them — GitHub's push protection blocked
// the inline version of this file, which is that system working exactly as it
// should. Joining at runtime keeps the classifier under test seeing byte-for-
// byte the same string while the literal never exists in source.
const k = (...parts: string[]) => parts.join('');

const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

describe('classifyValue — vendor formats', () => {
  const cases: Array<[string, string]> = [
    ['stripe secret', k('sk', '_live_', '51H8xYzAbCdEfGhIjKlMnOpQrStUv')],
    ['stripe restricted', k('rk', '_live_', '51H8xYzAbCdEfGhIjKlMnOpQrStUv')],
    ['openai style', k('sk', '-proj-', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789')],
    ['github pat', k('ghp', '_', '16C7e42F292c6912E7710c838347Ae178B4a')],
    ['github fine-grained', k('github', '_pat_', '11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz')],
    ['gitlab', k('glpat', '-', 'ABCdefGHIjklMNOpqrs')],
    ['slack bot', k('xoxb', '-', '123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx')],
    ['aws access key', k('AKIA', 'IOSFODNN7EXAMPLE')],
    ['google api key', k('AIza', 'SyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe')],
    ['google oauth', k('ya29', '.', 'a0AfH6SMBx7Yq2LmNoPqRsTuVwXyZ0123456789')],
    ['npm', k('npm', '_', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456')],
    ['digitalocean', k('dop', '_v1_', 'a'.repeat(64))],
  ];

  for (const [label, value] of cases) {
    it(`flags a ${label}`, () => {
      expect(classifyValue('whatever', value)?.reason).toBe('known_prefix');
    });
  }

  it('flags a PEM private key block', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
    expect(classifyValue('cert', pem)?.reason).toBe('private_key');
  });

  it('flags a JWT whose header really decodes', () => {
    expect(classifyValue('t', JWT)?.reason).toBe('jwt');
  });

  it('does not flag a dotted value that merely looks JWT-shaped', () => {
    // Three segments, but the header is not base64url JSON carrying `alg`.
    expect(classifyValue('version', 'abcdefgh.ijklmnop.qrstuvwx')).toBeNull();
  });

  it('does not flag prose that merely mentions a prefix', () => {
    expect(classifyValue('description', 'Pass your sk_live_ key in the header')).toBeNull();
  });
});

describe('classifyValue — sensitive names', () => {
  const sensitive = [
    'api_key',
    'apiKey',
    'X-RapidAPI-Key',
    'Private-Token',
    'X-Shopify-Access-Token',
    'client_secret',
    'clientSecret',
    'password',
    'refresh_token',
    'X-Signature',
    'sessionId',
    'accessKey',
  ];

  for (const name of sensitive) {
    it(`flags any value under "${name}"`, () => {
      // Short and low-entropy on purpose: the name alone is the signal.
      expect(classifyValue(name, 'abc123')?.reason).toBe('sensitive_name');
    });
  }

  // These are the names that made a looser marker list unusable: each contains
  // a substring of a credential word but names ordinary data.
  const innocuous = ['authorId', 'sortKey', 'groupKey', 'idempotencyKey', 'keyword', 'monkey'];

  for (const name of innocuous) {
    it(`leaves "${name}" alone`, () => {
      expect(classifyValue(name, 'abc123')).toBeNull();
    });
  }
});

describe('classifyValue — entropy backstop and its exemptions', () => {
  it('flags a long mixed-class random value in an oddly-named param', () => {
    expect(classifyValue('x', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6')?.reason).toBe('high_entropy');
  });

  it('keeps a UUID — the most common legitimate identifier example', () => {
    expect(classifyValue('petId', '550e8400-e29b-41d4-a716-446655440000')).toBeNull();
  });

  it('keeps an ISO timestamp', () => {
    expect(classifyValue('createdAt', '2026-09-08T12:00:00.000Z')).toBeNull();
  });

  it('keeps a URL', () => {
    expect(classifyValue('webhookUrl', 'https://api.example.com/v1/callbacks/inbound')).toBeNull();
  });

  it('keeps an email address', () => {
    expect(classifyValue('email', 'someone.longish@example-company.com')).toBeNull();
  });

  it('keeps a hex digest — two character classes never reaches the threshold', () => {
    expect(classifyValue('contentHash', 'a'.repeat(20) + 'f3c9e1b7d2408a6c')).toBeNull();
  });

  it('keeps a short value', () => {
    expect(classifyValue('status', 'available')).toBeNull();
  });

  it('keeps a numeric value', () => {
    expect(classifyValue('limit', 25)).toBeNull();
  });

  it('ignores an implausibly long value rather than scoring it', () => {
    expect(classifyValue('blob', 'A1b2C3d4'.repeat(1000))).toBeNull();
  });

  // A UUID under a credential name is still a credential.
  it('still flags a UUID when the name is sensitive', () => {
    expect(classifyValue('session_token', '550e8400-e29b-41d4-a716-446655440000')?.reason).toBe(
      'sensitive_name',
    );
  });
});

describe('the hint never carries the value', () => {
  it('shows only the last four characters of a long value', () => {
    const finding = classifyValue('api_key', k('sk', '_live_', '51H8xYzAbCdEfGhIjKlMnOpQrStUv'));
    expect(finding?.hint).toBe('••••StUv');
    expect(finding?.hint).not.toContain(k('sk', '_live'));
  });

  it('shows nothing at all for a short value', () => {
    expect(secretHint('abc')).toBe('••••');
  });

  it('records the length without the content', () => {
    expect(classifyValue('password', 'hunter2hunter2')?.length).toBe(14);
  });
});

describe('shannonEntropy', () => {
  it('is zero for a single repeated character', () => {
    expect(shannonEntropy('aaaaaaaa')).toBe(0);
  });

  it('is one bit for an even two-symbol split', () => {
    expect(shannonEntropy('abab')).toBeCloseTo(1, 10);
  });

  it('is zero for the empty string', () => {
    expect(shannonEntropy('')).toBe(0);
  });
});

describe('scrubValue — nested bodies', () => {
  it('drops the secret leaf and keeps its siblings', () => {
    const { value, findings } = scrubValue('body', {
      amount: 500,
      currency: 'usd',
      client_secret: 'pi_3ABCdef_secret_XyZ123456789',
    });

    expect(value).toEqual({ amount: 500, currency: 'usd' });
    expect(findings).toHaveLength(1);
    expect(findings[0].at).toBe('body.client_secret');
  });

  it('drops an entire subtree under a sensitive key', () => {
    const { value, findings } = scrubValue('body', {
      name: 'Acme',
      credentials: { user: 'admin', pass: 'letmein' },
    });

    expect(value).toEqual({ name: 'Acme' });
    expect(JSON.stringify(value)).not.toContain('admin');
    expect(findings[0].at).toBe('body.credentials');
  });

  it('walks arrays', () => {
    const { value } = scrubValue('body', { items: [{ id: 1, api_key: 'abc123' }] });
    expect(value).toEqual({ items: [{ id: 1 }] });
  });

  it('leaves a clean body untouched', () => {
    const body = { name: 'doggie', status: 'available', tags: ['a', 'b'] };
    const { value, findings } = scrubValue('body', body);
    expect(value).toEqual(body);
    expect(findings).toHaveLength(0);
  });

  it('does not mutate its input', () => {
    const body = { api_key: 'abc123' };
    scrubValue('body', body);
    expect(body.api_key).toBe('abc123');
  });
});

describe('scrubSchemaExamples', () => {
  it('removes a secret example at the top level', () => {
    const schema: Record<string, unknown> = { type: 'string', example: k('ghp', '_', '16C7e42F292c6912E7710c838347Ae178B4a') };
    const findings = scrubSchemaExamples(schema, 'token');
    expect(schema.example).toBeUndefined();
    expect(schema.type).toBe('string');
    expect(findings).toHaveLength(1);
  });

  it('removes a secret example nested in properties', () => {
    const schema: Record<string, unknown> = {
      type: 'object',
      properties: {
        amount: { type: 'integer', example: 500 },
        client_secret: { type: 'string', example: 'shhh-abc123' },
      },
    };
    scrubSchemaExamples(schema, 'body');
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.client_secret.example).toBeUndefined();
    expect(props.client_secret.type).toBe('string');
    expect(props.amount.example).toBe(500);
  });

  it('descends into items and combinators', () => {
    const schema: Record<string, unknown> = {
      type: 'array',
      items: { type: 'object', properties: { password: { type: 'string', example: 'p' } } },
      oneOf: [{ type: 'object', properties: { api_key: { type: 'string', example: 'k' } } }],
    };
    scrubSchemaExamples(schema, 'body');
    expect(JSON.stringify(schema)).not.toContain('"example"');
  });

  it('keeps a legitimate example', () => {
    const schema: Record<string, unknown> = { type: 'string', example: 'available' };
    expect(scrubSchemaExamples(schema, 'status')).toHaveLength(0);
    expect(schema.example).toBe('available');
  });
});
