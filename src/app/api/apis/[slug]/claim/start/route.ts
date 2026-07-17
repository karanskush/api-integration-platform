import { randomUUID } from 'node:crypto';
import { auth, currentUser } from '@clerk/nextjs/server';
import { eq } from 'drizzle-orm';
import { dbReady, getDb } from '@/lib/db';
import { apis, claims } from '@/lib/db/schema';
import { getOrCreateOrgForUser } from '@/lib/org';

export const maxDuration = 30;

const HOSTNAME_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;

type ClaimMethod = 'dns' | 'meta' | 'email';

function instructionsFor(method: ClaimMethod, domain: string, token: string): string {
  if (method === 'dns') {
    return `Add a TXT record named "_spotcheck-verify.${domain}" with the value "${token}", then come back and verify.`;
  }
  if (method === 'meta') {
    return `Add <meta name="spotcheck-verification" content="${token}"> to the <head> of https://${domain}/, then come back and verify.`;
  }
  return `We'll verify this against your signed-in account's email domain — no action needed, just click verify.`;
}

// Starts a domain-ownership claim on an existing unclaimed API page. Distinct
// from api/apis/claim/route.ts (claims a fresh ephemeral import into the
// caller's own account) — this claims a page that already belongs to no one.
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  if (!dbReady()) {
    return Response.json({ error: 'Persistence is not configured — connect Postgres and redeploy' }, { status: 503 });
  }

  const { userId } = await auth();
  if (!userId) return Response.json({ error: 'Sign in required' }, { status: 401 });

  const { slug } = await ctx.params;

  let body: { domain?: unknown; method?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const domain = typeof body.domain === 'string' ? body.domain.trim().toLowerCase() : '';
  if (!HOSTNAME_RE.test(domain)) {
    return Response.json({ error: 'domain must be a bare hostname, e.g. "api.example.com" (no protocol or path)' }, { status: 400 });
  }
  const method = body.method;
  if (method !== 'dns' && method !== 'meta' && method !== 'email') {
    return Response.json({ error: 'method must be one of "dns", "meta", "email"' }, { status: 400 });
  }

  const db = getDb();
  const [api] = await db.select().from(apis).where(eq(apis.slug, slug)).limit(1);
  if (!api) return Response.json({ error: 'Unknown API' }, { status: 404 });
  if (api.claimStatus !== 'unclaimed') {
    return Response.json({ error: 'This API is already claimed or has a claim in progress' }, { status: 409 });
  }

  const user = await currentUser();
  const email = user?.primaryEmailAddress?.emailAddress ?? user?.emailAddresses[0]?.emailAddress;
  if (!email) return Response.json({ error: 'Your account has no email address on file' }, { status: 400 });

  const { user: dbUser } = await getOrCreateOrgForUser(db, userId, email);

  const token = randomUUID();
  const [claim] = await db
    .insert(claims)
    .values({ apiId: api.id, userId: dbUser.id, method, domain, token, status: 'pending' })
    .returning();

  return Response.json({
    claimId: claim.id,
    method,
    domain,
    instructions: instructionsFor(method, domain, token),
  });
}
