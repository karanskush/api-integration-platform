import { auth } from '@clerk/nextjs/server';
import { ownershipError, resolveApiOwnership } from '@/lib/apiOwnership';
import { parseConsentPatch, parseCredentialPost } from '@/lib/credentialRequest';
import { dbReady, getDb } from '@/lib/db';
import { masterKeyReady } from '@/lib/keys';
import { actorHashForToken } from '@/lib/mcpAccess';
import { loadPersistentRecord } from '@/lib/persistentApi';
import { getLimiter, tooMany } from '@/lib/ratelimit';
import { VaultError } from '@/lib/vault';
import {
  credentialGate,
  CREDENTIAL_ENVIRONMENTS,
  deleteCredential,
  listCredentialMeta,
  recentAuditForApi,
  storeCredential,
  updateCredentialConsents,
  writeAudit,
  type CredentialEnvironment,
} from '@/lib/vaultStore';

export const maxDuration = 30;

// The vault's owner surface. Two lanes with two gates: a SANDBOX credential —
// a test key the probes may use for writes with cleanup, and for rate-limit
// discovery, on every plan — and a PRODUCTION credential, Team+. Environment is
// parsed before the gate, because the gate depends on it.
//
// Plaintext never comes back out. It is decrypted only inside the MCP and probe
// execution paths, and every decrypt is audited; the trail is returned here so
// the owner can see it beside the credential.

const WRITE_LIMIT = { limit: 20, windowSec: 600 };

function notConfigured(): Response {
  return Response.json(
    { error: 'The credential vault is not configured — set DOCENTAPI_MASTER_KEY and redeploy' },
    { status: 503 },
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

function gateResponse(plan: string, environment: CredentialEnvironment): Response | null {
  const gate = credentialGate(plan, environment);
  return gate.ok ? null : Response.json({ error: gate.error }, { status: gate.status });
}

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const authorized = await authorize(slug);
  if (authorized.error) return authorized.error;
  const { db, api } = authorized;

  const gates = {
    sandbox: credentialGate(api.orgPlan, 'sandbox').ok,
    production: credentialGate(api.orgPlan, 'production').ok,
  };
  if (!gates.sandbox && !gates.production) {
    const denied = gateResponse(api.orgPlan, 'production');
    if (denied) return denied;
  }

  const [credentials, audit] = await Promise.all([listCredentialMeta(db, api.id), recentAuditForApi(db, api.orgId, api.id, 20)]);
  return Response.json({
    slug: api.slug,
    credentials,
    audit,
    gates,
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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // The API's base URLs let the inference notice a sandbox-looking host.
  const record = await loadPersistentRecord(api.slug);
  const parsed = parseCredentialPost(body, { baseUrls: record?.baseUrls ?? [] });
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
  const { value } = parsed;

  const gate = gateResponse(api.orgPlan, value.environment);
  if (gate) {
    // A refused store is itself worth a row in the trail.
    await writeAudit(db, {
      orgId: api.orgId,
      apiId: api.id,
      environment: value.environment,
      action: 'denied',
      actor: { type: 'user', hash: actorHashForToken(clerkUserId) },
      detail: `plan=${api.orgPlan}`,
    });
    return gate;
  }

  try {
    const stored = await storeCredential(db, {
      orgId: api.orgId,
      apiId: api.id,
      environment: value.environment,
      secret: value.secret,
      createdBy: api.userId,
      actor: { type: 'user', hash: actorHashForToken(clerkUserId) },
      label: value.label,
      writeConsent: value.writeConsent,
      burstConsent: value.burstConsent,
      consentedBy: api.userId,
      inferred: value.inferred,
    });
    return Response.json({
      slug: api.slug,
      credential: stored,
      ...(value.warning ? { warning: value.warning } : {}),
      note:
        value.environment === 'sandbox'
          ? 'Stored encrypted. Used only by DocentAPI’s probes against your sandbox; every use is audited and you can revoke it here at any time.'
          : 'Stored encrypted. This value cannot be read back — rotate by POSTing a new one.',
    });
  } catch (err) {
    if (err instanceof VaultError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    console.error('[vault] store failed', { slug: api.slug, environment: value.environment });
    return Response.json({ error: 'Could not store credential' }, { status: 500 });
  }
}

// Consents and the label, on the sandbox credential only.
export async function PATCH(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const authorized = await authorize(slug);
  if (authorized.error) return authorized.error;
  const { db, clerkUserId, api } = authorized;

  const rl = await getLimiter('vault-write', WRITE_LIMIT).limit(clerkUserId);
  if (!rl.success) return tooMany(rl.reset);

  const gate = gateResponse(api.orgPlan, 'sandbox');
  if (gate) return gate;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = parseConsentPatch(body);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });

  const updated = await updateCredentialConsents(db, {
    orgId: api.orgId,
    apiId: api.id,
    ...parsed.value,
    consentedBy: api.userId,
    actor: { type: 'user', hash: actorHashForToken(clerkUserId) },
  });
  if (!updated) return Response.json({ error: 'No sandbox credential stored for this API' }, { status: 404 });
  return Response.json({ slug: api.slug, credential: updated });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const authorized = await authorize(slug);
  if (authorized.error) return authorized.error;
  const { db, clerkUserId, api } = authorized;

  const rl = await getLimiter('vault-write', WRITE_LIMIT).limit(clerkUserId);
  if (!rl.success) return tooMany(rl.reset);

  // Deliberately not plan-gated: an owner must always be able to remove a key,
  // including after a downgrade.
  const url = new URL(req.url);
  const environment = (url.searchParams.get('environment') ?? 'production').trim().toLowerCase();
  if (!(CREDENTIAL_ENVIRONMENTS as readonly string[]).includes(environment)) {
    return Response.json({ error: `environment must be one of: ${CREDENTIAL_ENVIRONMENTS.join(', ')}` }, { status: 400 });
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
