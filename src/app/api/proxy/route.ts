import { isValidId } from '@/lib/ids';
import { clientIp } from '@/lib/ip';
import { kv } from '@/lib/kv';
import { loadPersistentRecord } from '@/lib/persistentApi';
import { getLimiter, tooMany } from '@/lib/ratelimit';
import { safeFetch, SsrfError, UpstreamError } from '@/lib/ssrf';
import { buildUpstreamRequest, UpstreamBuildError } from '@/lib/upstream';
import { validateParams } from '@/lib/validate';

export const maxDuration = 60;

// BYOK playground proxy: same-origin only, allowlisted base URLs, injects
// nothing beyond the caller's own key, persists nothing. Logs carry no
// params, bodies, or credentials.
export async function POST(req: Request) {
  const rl = await getLimiter('proxy', { limit: 60, windowSec: 60 }).limit(clientIp(req));
  if (!rl.success) return tooMany(rl.reset);

  let payload: {
    id?: unknown;
    actionId?: unknown;
    params?: unknown;
    baseUrl?: unknown;
    auth?: { token?: unknown };
  };
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const id = typeof payload.id === 'string' ? payload.id : '';
  if (!id) return Response.json({ error: 'Unknown import' }, { status: 404 });

  // Ephemeral ids (Redis-backed) are a fixed 10-char shape; anything else is
  // treated as a persistent api slug (Postgres-backed) — same two storage
  // tiers /p/[id] vs /[slug] and /mcp/[id] vs /mcp/[slug] already split on.
  // A slug can rarely happen to have the same 10-char shape as an ephemeral
  // id, so an id-shaped miss in Redis still falls back to Postgres.
  const record = isValidId(id)
    ? ((await kv().getImport(id)) ?? (await loadPersistentRecord(id)))
    : await loadPersistentRecord(id);
  if (!record || record.expiresAt <= Date.now()) {
    return Response.json({ error: 'Import expired' }, { status: 404 });
  }

  const action = record.actions.find((a) => a.id === payload.actionId);
  if (!action) return Response.json({ error: 'Unknown action' }, { status: 404 });

  const baseUrl = typeof payload.baseUrl === 'string' ? payload.baseUrl : record.baseUrls[0];
  if (!baseUrl || !record.baseUrls.includes(baseUrl)) {
    return Response.json({ error: 'Base URL not allowed for this import' }, { status: 403 });
  }

  const params = (payload.params ?? {}) as Record<string, unknown>;
  const invalid = validateParams(action, params);
  if (invalid) return Response.json({ error: `Invalid parameters: ${invalid}` }, { status: 400 });

  const token = typeof payload.auth?.token === 'string' ? payload.auth.token : undefined;

  const started = Date.now();
  try {
    const upstream = buildUpstreamRequest(action, params, { token }, baseUrl, record.authIn);
    const res = await safeFetch(upstream.url, {
      method: upstream.method,
      headers: upstream.headers,
      body: upstream.body,
      timeoutMs: 15_000,
      maxBytes: 2 * 1024 * 1024,
    });

    console.log('[proxy]', { id, actionId: action.id, status: res.status, latencyMs: res.latencyMs });
    return new Response(res.body.length ? (res.body as BodyInit) : null, {
      status: res.status,
      headers: {
        'content-type': 'application/octet-stream',
        'x-upstream-content-type': res.headers.get('content-type') ?? 'unknown',
        'x-upstream-latency-ms': String(res.latencyMs),
      },
    });
  } catch (err) {
    const latencyMs = Date.now() - started;
    if (err instanceof UpstreamBuildError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof SsrfError) {
      console.log('[proxy] blocked', { id, actionId: action.id, latencyMs });
      return Response.json({ error: 'Upstream URL blocked' }, { status: 403 });
    }
    if (err instanceof UpstreamError) {
      return Response.json({ error: err.message }, { status: 502 });
    }
    console.error('[proxy] unexpected', { id, actionId: action.id });
    return Response.json({ error: 'Proxy request failed' }, { status: 500 });
  }
}
