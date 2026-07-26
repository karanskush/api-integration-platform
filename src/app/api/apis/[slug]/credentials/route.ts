import { auth } from '@clerk/nextjs/server';
import { ownershipError, resolveApiOwnership } from '@/lib/apiOwnership';
import { dbReady, getDb } from '@/lib/db';
import { masterKeyReady } from '@/lib/keys';
import { actorHashForToken } from '@/lib/mcpAccess';
import { can } from '@/lib/plans';
import { getLimiter, tooMany } from '@/lib/ratelimit';
import { VaultError } from '@/lib/vault';
import { deleteCredential, listCredentialMeta, storeCredential, writeAudit } from '@/lib/vaultStore';

export const maxDuration = 30;

const WRITE_LIMIT = { limit: 20, windowSec: 600 };
const ENVIRONMENTS = ['production', 'sandbox'] as const;

// Vaulted upstream credentials for one API (Team+). BYOK stays the default
// everywhere; this is the opt-in for teams that would rather Spotcheck hold the
// key than paste it into every agent config.
//
// GET returns metadata only — fingerprint, hint, versions, timestamps. There is
// deliberately no read-back endpoint for the plaintext: the only code path that
// decrypts is resolveCredential(), inside the MCP/probe execution path, and
// adding a "show me my key" route would turn one audited execution path into an
// unaudited exfiltration one.

function notConfigured(): Response {
  return Response.json(
    { error: 'The credential vault is not configured — set SPOTCHECK_MASTER_KEY and redeploy' },
    { status: 503 },
  );
}

function planGate(plan: string): Response | null {
  return can(plan, 'vaultedCredentials')
    ? null
    : Response.json(
        { error: 'Vaulted credentials are a Team plan feature — upgrade, or keep passing your key per request (BYOK).' },
        { status: 403 },
      );
}

async function authorize(slug: string) {
  if (!dbReady()) {
    return { error: Response.json({ error: 'Persistence is not configured — connect Postgres and redeploy' }, { status: 503 }) };
  }
  if (!masterKeyReady()) return { error: notConfigured() };

  const { userId } = await auth();
  if (!userId) return { error: Response.json({ error: 'Sign in required' }, { status: 401 }) };

  const db = getDb();
  const owned = await resolveApiOwnership(db, slug, userId);
  if (!owned.ok) {
    return {
      error: ownershipError(
        owned.reason,
        owned.reason === 'unclaimed' ? 'Claim this API before storing credentials for it.' : undefined,
      ),
    };
  }
  return { db, clerkUserId: userId, api: owned.api };
}

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const authorized = await authorize(slug);
  if (authorized.error) return authorized.error;
  const { db, api } = authorized;

  const gate = planGate(api.orgPlan);
  if (gate) return gate;

  return Response.json({
    slug: api.slug,
    credentials: await listCredentialMeta(db, api.id),
    note: 'Plaintext is never returned. It is decrypted only inside the MCP and probe execution paths, and every decrypt is audited.',
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const authorized = await authorize(slug);
  if (authorized.error) return authorized.error;
  const { db, clerkUserId, api } = authorized;

  const rl = await getLimiter('vault-write', WRITE_LIMIT).limit(clerkUserId);
  if (!rl.success) return tooMany(rl.reset);

  const gate = planGate(api.orgPlan);
  if (gate) {
    // A denied attempt on a real API is exactly the kind of thing an owner
    // should be able to see later.
    await writeAudit(db, {
      orgId: api.orgId,
      apiId: api.id,
      action: 'denied',
      actor: { type: 'user', hash: actorHashForToken(clerkUserId) },
      detail: `plan=${api.orgPlan}`,
    });
    return gate;
  }

  let body: { secret?: unknown; environment?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const secret = typeof body.secret === 'string' ? body.secret.trim() : '';
  if (!secret) return Response.json({ error: 'secret is required' }, { status: 400 });

  const environment = typeof body.environment === 'string' ? body.environment.trim().toLowerCase() : 'production';
  if (!ENVIRONMENTS.includes(environment as (typeof ENVIRONMENTS)[number])) {
    return Response.json({ error: `environment must be one of: ${ENVIRONMENTS.join(', ')}` }, { status: 400 });
  }

  try {
    const stored = await storeCredential(db, {
      orgId: api.orgId,
      apiId: api.id,
      environment,
      secret,
      createdBy: api.userId,
      actor: { type: 'user', hash: actorHashForToken(clerkUserId) },
    });
    return Response.json({
      slug: api.slug,
      credential: stored,
      note: 'Stored encrypted. This value cannot be read back — rotate by POSTing a new one.',
    });
  } catch (err) {
    if (err instanceof VaultError) {
      // VaultError messages are written to never contain key material.
      return Response.json({ error: err.message }, { status: 400 });
    }
    console.error('[vault] store failed', { slug: api.slug, environment });
    return Response.json({ error: 'Could not store credential' }, { status: 500 });
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const authorized = await authorize(slug);
  if (authorized.error) return authorized.error;
  const { db, clerkUserId, api } = authorized;

  const rl = await getLimiter('vault-write', WRITE_LIMIT).limit(clerkUserId);
  if (!rl.success) return tooMany(rl.reset);

  // Deliberately NOT plan-gated: a downgraded org must always be able to remove
  // credentials it can no longer use.
  const url = new URL(req.url);
  const environment = (url.searchParams.get('environment') ?? 'production').trim().toLowerCase();
  if (!ENVIRONMENTS.includes(environment as (typeof ENVIRONMENTS)[number])) {
    return Response.json({ error: `environment must be one of: ${ENVIRONMENTS.join(', ')}` }, { status: 400 });
  }

  const removed = await deleteCredential(db, {
    orgId: api.orgId,
    apiId: api.id,
    environment,
    actor: { type: 'user', hash: actorHashForToken(clerkUserId) },
  });

  return removed
    ? Response.json({ deleted: true, environment })
    : Response.json({ error: 'No credential stored for that environment' }, { status: 404 });
}
