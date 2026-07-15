import { convert } from '@scalar/postman-to-openapi';

export class PostmanConvertError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PostmanConvertError';
  }
}

export function postmanToOpenApi(doc: Record<string, unknown>): Record<string, unknown> {
  try {
    return convert(doc as never) as unknown as Record<string, unknown>;
  } catch (err) {
    throw new PostmanConvertError(
      `Could not convert Postman collection: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
  }
}
