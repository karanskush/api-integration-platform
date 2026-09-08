import { auth } from '@clerk/nextjs/server';
import { eq } from 'drizzle-orm';
import { ownershipError, resolveApiOwnership } from '@/lib/apiOwnership';
import { dbReady, getDb } from '@/lib/db';
import { apis } from '@/lib/db/schema';
import { purgeApiSurfaces } from '@/lib/purge';
import { getLimiter, tooMany } from '@/lib/ratelimit';

export const maxDuration = 30;

const DELETE_LIMIT = { limit: 10, windowSec: 600 };

// Removing an API is one row delete: every child table — spec versions,
// actions, evidence facts, scores and previews, credentials and their audit
// trail, the MCP call log, analysis runs, clarifications — references
// apis.id with onDelete: cascade (pinned by schema.test.ts) — with ONE
// deliberate exception: credential_audit.api_id is SET NULL, so the record of
// every decrypt survives the API it described (GAP_ANALYSIS §0.4). Blob spec
// snapshots are content-hash addressed and deliberately left behind; they
// carry no org identity and a re-import of the same bytes would recreate
// the same ref.
//
// The response says both of those out loud rather than telling the owner
// everything is gone.
//
// requireClaimed is off: deep-analysis submissions persist to the org
// without a claim ceremony, and an org member must be able to remove those
// too. Membership itself is still enforced.
export async function DELETE(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  if (!dbReady()) {
    return Response.json({ error: 'Persistence is not configured — connect Postgres and redeploy' }, { status: 503 });
  }

  const { userId } = await auth();
  if (!userId) return Response.json({ error: 'Sign in required' }, { status: 401 });

  const rl = await getLimiter('api-delete', DELETE_LIMIT).limit(userId);
  if (!rl.success) return tooMany(rl.reset);

  const { slug } = await ctx.params;
  const db = getDb();
  const owned = await resolveApiOwnership(db, slug, userId, { requireClaimed: false });
  if (!owned.ok) return ownershipError(owned.reason);

  await db.delete(apis).where(eq(apis.id, owned.api.id));

  // The public page and badge must stop serving now, not when their cache
  // happens to expire — same contract as flipping visibility to private.
  purgeApiSurfaces(owned.api.slug);

  return Response.json({
    slug: owned.api.slug,
    deleted: true,
    // Says what is actually true. The previous wording — "...are gone. This
    // cannot be undone." — was contradicted by this route's own header comment:
    // Blob spec snapshots are content-hash addressed and deliberately retained,
    // and the credential audit trail is now kept on purpose (§0.4). Telling an
    // owner their data is gone when some of it is not is the same class of
    // overclaim as a green badge nobody earned.
    note:
      'The page, badge, playground, MCP server, stored credentials, and verification history for this API have been removed. This cannot be undone.',
    retained: {
      credentialAudit:
        'The record of when this API\'s credential was used or failed to decrypt is kept, attributable to your org. It is what makes a vaulted credential defensible, so it outlives the API it belonged to.',
      specSnapshot:
        'The raw uploaded spec bytes remain in blob storage, addressed by content hash rather than by org. Re-importing the same bytes would reuse the same object, which is why removal needs reference counting that does not exist yet.',
    },
  });
}
