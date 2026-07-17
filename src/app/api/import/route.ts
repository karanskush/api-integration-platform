import { corsPreflight, withCorsJson } from '@/lib/cors';
import { newId } from '@/lib/ids';
import { runImport, ImportInputError } from '@/lib/importer';
import { CurlParseError } from '@/lib/importer/curl';
import { DetectError } from '@/lib/importer/detect';
import { ParseError } from '@/lib/importer/openapi';
import { PostmanConvertError } from '@/lib/importer/postman';
import { clientIp } from '@/lib/ip';
import { kv, storageReady } from '@/lib/kv';
import { ttlSeconds } from '@/lib/ir';
import { getLimiter, tooMany } from '@/lib/ratelimit';
import { SsrfError, UpstreamError } from '@/lib/ssrf';

export const maxDuration = 60;

const MAX_TEXT_BYTES = 1024 * 1024;

function appOrigin(req: Request): string {
  return process.env.PUBLIC_APP_ORIGIN?.replace(/\/$/, '') || new URL(req.url).origin;
}

export async function OPTIONS(req: Request) {
  return corsPreflight(req);
}

export async function POST(req: Request) {
  if (!storageReady()) {
    return withCorsJson(req, { error: 'Storage not configured — connect Upstash Redis and redeploy' }, { status: 503 });
  }
  const rl = await getLimiter('import', { limit: 10, windowSec: 600 }).limit(clientIp(req));
  if (!rl.success) return tooMany(rl.reset);

  let body: { url?: unknown; text?: unknown };
  try {
    body = await req.json();
  } catch {
    return withCorsJson(req, { error: 'Invalid JSON body' }, { status: 400 });
  }

  const url = typeof body.url === 'string' ? body.url.trim() : undefined;
  const text = typeof body.text === 'string' ? body.text : undefined;
  if (text && Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
    return withCorsJson(req, { error: 'Pasted spec is too large (max 1MB)' }, { status: 413 });
  }

  try {
    const { record, rawText } = await runImport({ url: url || undefined, text: text || undefined });
    const ttl = ttlSeconds();
    await kv().setImport(record, ttl);
    await kv().setRawSpec(record.id, rawText, ttl);

    const origin = appOrigin(req);
    return withCorsJson(req, {
      id: record.id,
      pageUrl: `${origin}/p/${record.id}`,
      mcpUrl: `${origin}/mcp/${record.id}`,
      expiresAt: record.expiresAt,
      summary: {
        name: record.name,
        source: record.source,
        actionCount: record.counts.total,
        auth: record.auth,
        counts: record.counts,
      },
    });
  } catch (err) {
    if (err instanceof SsrfError) {
      return withCorsJson(req, { error: `URL not allowed: ${err.message}` }, { status: 400 });
    }
    if (err instanceof UpstreamError) {
      return withCorsJson(req, { error: err.message }, { status: 502 });
    }
    if (
      err instanceof ImportInputError ||
      err instanceof DetectError ||
      err instanceof CurlParseError ||
      err instanceof PostmanConvertError ||
      err instanceof ParseError
    ) {
      const status = err instanceof ImportInputError ? 400 : 422;
      return withCorsJson(req, { error: err.message }, { status });
    }
    console.error('[import] unexpected failure', { ref: newId(6), err });
    return withCorsJson(req, { error: 'Import failed unexpectedly' }, { status: 500 });
  }
}
