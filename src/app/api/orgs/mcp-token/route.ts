import { auth, currentUser } from '@clerk/nextjs/server';
import { eq, sql } from 'drizzle-orm';
import { dbReady, getDb } from '@/lib/db';
import { orgs } from '@/lib/db/schema';
import { masterKeyReady } from '@/lib/keys';
import { MCP_ACCESS_HEADER, mcpAccessTokenFor } from '@/lib/mcpAccess';
import { getOrCreateOrgForUser } from '@/lib/org';
import { can } from '@/lib/plans';
import { getLimiter, tooMany } from '@/lib/ratelimit';

export const maxDuration = 30;

const TOKEN_LIMIT = { limit: 10, windowSec: 3600 };

// The org's MCP access token: what lets an agent use vaulted credentials instead
// of passing a key per request. Derived, not stored (see mcpAccess.ts), so
// re-reading it is safe and rotation is an explicit version bump.
//
// This token is the key to every credential the org has vaulted, so it is
// treated as one: Team+ only, rate limited, and returned with the rotation
// instructions rather than as a bare string.
export async function POST(req: Request) {
  if (!dbReady()) {
    return Response.json({ error: 'Persistence is not configured — connect Postgres and redeploy' }, { status: 503 });
  }
  if (!masterKeyReady()) {
    return Response.json({ error: 'The credential vault is not configured — set SPOTCHECK_MASTER_KEY and redeploy' }, { status: 503 });
  }

  const { userId } = await auth();
  if (!userId) return Response.json({ error: 'Sign in required' }, { status: 401 });

  const rl = await getLimiter('mcp-token', TOKEN_LIMIT).limit(userId);
  if (!rl.success) return tooMany(rl.reset);

  const user = await currentUser();
  const email = user?.primaryEmailAddress?.emailAddress ?? user?.emailAddresses[0]?.emailAddress;
  if (!email) return Response.json({ error: 'Your account has no email address on file' }, { status: 400 });

  const db = getDb();
  const { org } = await getOrCreateOrgForUser(db, userId, email);

  if (!can(org.plan, 'vaultedCredentials')) {
    return Response.json(
      {
        error:
          'MCP access tokens unlock vaulted credentials, which are a Team plan feature. Anonymous BYOK access to your MCP servers needs no token and is unaffected.',
      },
      { status: 403 },
    );
  }

  let body: { rotate?: unknown } = {};
  try {
    body = (await req.json()) as { rotate?: unknown };
  } catch {
    // Empty body means "just show me the current token".
  }

  let version = org.mcpTokenVersion;
  if (body.rotate === true) {
    const [updated] = await db
      .update(orgs)
      .set({ mcpTokenVersion: sql`${orgs.mcpTokenVersion} + 1`, updatedAt: new Date() })
      .where(eq(orgs.id, org.id))
      .returning({ mcpTokenVersion: orgs.mcpTokenVersion });
    version = updated.mcpTokenVersion;
  }

  return Response.json({
    token: mcpAccessTokenFor(org.id, version),
    tokenVersion: version,
    rotated: body.rotate === true,
    usage: {
      header: MCP_ACCESS_HEADER,
      note: `Send this as the ${MCP_ACCESS_HEADER} header on MCP requests to use credentials vaulted for your APIs. Without it, callers must supply their own key per request (BYOK), which is the default. Rotate with {"rotate":true} — that immediately revokes every token previously issued for this org.`,
      warning: 'This token authorizes use of every credential your org has vaulted. Treat it like the credentials themselves.',
    },
  });
}
