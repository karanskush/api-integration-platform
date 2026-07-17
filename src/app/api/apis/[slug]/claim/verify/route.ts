import { auth, currentUser } from '@clerk/nextjs/server';
import { eq, sql } from 'drizzle-orm';
import { applyClaimVerification, verifyDnsClaim, verifyEmailClaim, verifyMetaClaim } from '@/lib/claims';
import { dbReady, getDb } from '@/lib/db';
import { apis, claims } from '@/lib/db/schema';
import { getOrCreateOrgForUser } from '@/lib/org';
import { limitsFor } from '@/lib/plans';

export const maxDuration = 30;

function appOrigin(req: Request): string {
  return process.env.PUBLIC_APP_ORIGIN?.replace(/\/$/, '') || new URL(req.url).origin;
}

// Checks a pending domain-ownership claim (see claim/start's route for how
// one is created). Distinct from api/apis/claim/route.ts.
export async function POST(req: Request) {
  if (!dbReady()) {
    return Response.json({ error: 'Persistence is not configured — connect Postgres and redeploy' }, { status: 503 });
  }

  const { userId } = await auth();
  if (!userId) return Response.json({ error: 'Sign in required' }, { status: 401 });

  let body: { claimId?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const claimId = typeof body.claimId === 'string' ? body.claimId : '';
  if (!claimId) return Response.json({ error: 'claimId is required' }, { status: 400 });

  const db = getDb();
  const [claim] = await db.select().from(claims).where(eq(claims.id, claimId)).limit(1);
  if (!claim) return Response.json({ error: 'Unknown claim' }, { status: 404 });

  const user = await currentUser();
  const email = user?.primaryEmailAddress?.emailAddress ?? user?.emailAddresses[0]?.emailAddress;
  if (!email) return Response.json({ error: 'Your account has no email address on file' }, { status: 400 });

  const { user: dbUser, org } = await getOrCreateOrgForUser(db, userId, email);
  if (claim.userId !== dbUser.id) {
    return Response.json({ error: 'This claim does not belong to you' }, { status: 403 });
  }

  const [api] = await db.select().from(apis).where(eq(apis.id, claim.apiId)).limit(1);
  if (!api) return Response.json({ error: 'Unknown API' }, { status: 404 });

  let verified: boolean;
  if (claim.method === 'dns') {
    verified = await verifyDnsClaim(claim.domain, claim.token);
  } else if (claim.method === 'meta') {
    verified = await verifyMetaClaim(claim.domain, claim.token);
  } else {
    verified = verifyEmailClaim(email, claim.domain);
  }

  if (verified) {
    const result = await applyClaimVerification(db, {
      claimId: claim.id,
      apiId: api.id,
      orgId: org.id,
      createdBy: dbUser.id,
    });
    if (result === 'over_limit') {
      const limit = limitsFor(org.plan).maxPersistentApis;
      return Response.json(
        { error: `Your ${org.plan} plan allows up to ${limit} persistent API${limit === 1 ? '' : 's'} — upgrade to save more.` },
        { status: 403 },
      );
    }
    const origin = appOrigin(req);
    return Response.json({ verified: true, pageUrl: `${origin}/${api.slug}` });
  }

  await db.update(claims).set({ attempts: sql`${claims.attempts} + 1` }).where(eq(claims.id, claim.id));
  return Response.json({ verified: false });
}
