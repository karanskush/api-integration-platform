import { newId } from '../ids';
import type { ImportRecord, ImportSource } from '../ir';
import { ttlSeconds } from '../ir';
import { normalizeOpenApi } from '../normalize';
import { assertPublicUrl, safeFetch } from '../ssrf';
import { curlToOpenApi } from './curl';
import { detectInput } from './detect';
import { parseOpenApi } from './openapi';
import { postmanToOpenApi } from './postman';

export class ImportInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportInputError';
  }
}

export type ImportInput = { url?: string; text?: string };

const MAX_SPEC_BYTES = 5 * 1024 * 1024;

export type ImportResult = { record: ImportRecord; rawText: string };

// Returns the raw spec bytes alongside the normalized record — Phase 1's
// content-hash versioning (persist.ts) needs them; Phase 0's route just
// stores `record` and discards `rawText` via a companion ephemeral KV key.
export async function runImport(input: ImportInput): Promise<ImportResult> {
  let text: string;
  let sourceUrl: string | undefined;

  if (input.url && input.text) throw new ImportInputError('Provide either url or text, not both');
  if (input.url) {
    const res = await safeFetch(input.url, {
      timeoutMs: 10_000,
      maxBytes: MAX_SPEC_BYTES,
      headers: { accept: 'application/json, application/yaml, text/yaml, text/plain, */*' },
    });
    if (res.status >= 400) {
      throw new ImportInputError(`Spec URL returned HTTP ${res.status}`);
    }
    text = new TextDecoder().decode(res.body);
    sourceUrl = res.finalUrl;
  } else if (input.text) {
    text = input.text;
  } else {
    throw new ImportInputError('Provide a spec url or pasted text');
  }

  const detected = detectInput(text);
  let source: ImportSource;
  let oasDoc: Record<string, unknown>;

  switch (detected.kind) {
    case 'curl':
      source = 'curl';
      oasDoc = curlToOpenApi(detected.text);
      break;
    case 'postman':
      source = 'postman';
      oasDoc = await parseOpenApi(postmanToOpenApi(detected.doc));
      break;
    case 'swagger':
      source = 'swagger';
      oasDoc = await parseOpenApi(detected.doc);
      break;
    default:
      source = 'openapi';
      oasDoc = await parseOpenApi(detected.doc);
  }

  const normalized = normalizeOpenApi(oasDoc, sourceUrl);
  if (!normalized.actions.length) {
    throw new ImportInputError('No usable endpoints found in the spec');
  }

  // A malicious spec can declare internal servers — validate every base URL
  // with the same SSRF rules as fetches. These become the frozen allowlist
  // for the playground proxy and MCP tools/call.
  const baseUrls: string[] = [];
  for (const raw of normalized.rawBaseUrls) {
    try {
      await assertPublicUrl(raw);
      baseUrls.push(raw);
    } catch {
      // silently drop non-public base URLs
    }
  }

  const now = Date.now();
  const ttl = ttlSeconds();
  const counts = { total: normalized.actions.length, read: 0, write: 0, destructive: 0 };
  for (const a of normalized.actions) counts[a.safety]++;

  return {
    record: {
      id: newId(),
      name: normalized.name,
      source,
      sourceUrl,
      baseUrls,
      auth: normalized.auth,
      authIn: normalized.authIn,
      actions: normalized.actions,
      ...(normalized.truncated ? { truncated: true } : {}),
      ...(normalized.externalDocsUrl ? { externalDocsUrl: normalized.externalDocsUrl } : {}),
      counts,
      createdAt: now,
      expiresAt: now + ttl * 1000,
    },
    rawText: text,
  };
}
