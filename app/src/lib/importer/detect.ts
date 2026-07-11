import { parse as parseYaml } from 'yaml';

export type DetectedInput =
  | { kind: 'curl'; text: string }
  | { kind: 'openapi' | 'swagger'; doc: Record<string, unknown> }
  | { kind: 'postman'; doc: Record<string, unknown> };

export class DetectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DetectError';
  }
}

export function detectInput(text: string): DetectedInput {
  const trimmed = text.trim();
  if (!trimmed) throw new DetectError('Empty input');

  if (/^curl\s/i.test(trimmed)) return { kind: 'curl', text: trimmed };

  let doc: unknown;
  try {
    doc = JSON.parse(trimmed);
  } catch {
    try {
      doc = parseYaml(trimmed);
    } catch {
      throw new DetectError(
        'Could not parse input — expected an OpenAPI/Swagger document (JSON or YAML), a Postman collection, or a cURL command.',
      );
    }
  }

  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new DetectError('Parsed input is not an object — not a recognizable API spec.');
  }
  const obj = doc as Record<string, unknown>;

  const info = obj.info as Record<string, unknown> | undefined;
  const isPostman =
    Boolean(info?._postman_id) ||
    (Array.isArray(obj.item) && typeof info?.schema === 'string' && info.schema.includes('collection/v2'));
  if (isPostman) return { kind: 'postman', doc: obj };

  if (typeof obj.openapi === 'string' && obj.openapi.startsWith('3')) return { kind: 'openapi', doc: obj };
  if (obj.swagger === '2.0') return { kind: 'swagger', doc: obj };

  throw new DetectError(
    'Unrecognized document — expected OpenAPI 3.x, Swagger 2.0, or a Postman v2 collection.',
  );
}
