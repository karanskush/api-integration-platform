import { dereference, validate, compileErrors } from '@readme/openapi-parser';

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

// External $refs are ignored (never fetched) — outbound requests only ever go
// through ssrf.safeFetch. Leftover $ref nodes are tolerated by the normalizer.
const PARSER_OPTIONS = {
  resolve: { external: false, file: false },
  dereference: { circular: 'ignore' as const },
};

// Swagger 2 docs are converted to OAS 3 first so the normalizer only ever
// sees one dialect.
async function toOpenApi3(doc: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (doc.swagger !== '2.0') return doc;
  const s2o = await import('swagger2openapi');
  try {
    const result = await s2o.default.convertObj(doc as never, {
      patch: true, // fix minor non-compliance instead of failing
      warnOnly: true,
      resolve: false, // never fetch external refs
      anchors: true,
    });
    return result.openapi as unknown as Record<string, unknown>;
  } catch (err) {
    throw new ParseError(
      `Could not convert Swagger 2.0 document: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
  }
}

// Validate (best-effort — real-world specs often fail strict validation, so a
// failed validate falls back to plain dereference) and fully dereference.
export async function parseOpenApi(doc: Record<string, unknown>): Promise<Record<string, unknown>> {
  const oas = await toOpenApi3(doc);

  let strictErrors: string | null = null;
  try {
    // validate() mutates its input during dereferencing — hand it a copy.
    const result = await validate(structuredClone(oas) as never, PARSER_OPTIONS);
    if (!result.valid) strictErrors = compileErrors(result);
  } catch {
    // validator crashed on exotic input; dereference below is the real gate
  }

  try {
    return (await dereference(structuredClone(oas) as never, PARSER_OPTIONS)) as Record<string, unknown>;
  } catch (err) {
    const detail = strictErrors ?? (err instanceof Error ? err.message : 'unknown error');
    throw new ParseError(`Could not parse OpenAPI document: ${detail}`);
  }
}
