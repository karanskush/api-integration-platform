// CORS for the two endpoints the marketing site calls cross-origin
// (/api/import and /api/waitlist). Everything else is same-origin.

function allowedOrigins(): string[] {
  const raw = process.env.ALLOWED_SITE_ORIGINS;
  if (raw) return raw.split(',').map((o) => o.trim()).filter(Boolean);
  return ['http://localhost:5173', 'http://127.0.0.1:5173'];
}

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin');
  if (!origin || !allowedOrigins().includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export function corsPreflight(req: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}

export function withCorsJson(req: Request, body: unknown, init: ResponseInit = {}): Response {
  return Response.json(body, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), ...corsHeaders(req) },
  });
}
