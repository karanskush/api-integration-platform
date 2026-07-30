import { auth, currentUser } from '@clerk/nextjs/server';
import { eq } from 'drizzle-orm';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import ManageBillingButton from '@/components/product/ManageBillingButton';
import OrgBadge from '@/components/product/OrgBadge';
import RemoveApiButton from '@/components/product/RemoveApiButton';
import { dbReady, getDb } from '@/lib/db';
import { apis } from '@/lib/db/schema';
import { getOrCreateOrgForUser } from '@/lib/org';
import { loadVerifiedApiIds } from '@/lib/persistentApi';
import { limitsFor } from '@/lib/plans';

export const metadata: Metadata = { title: 'Dashboard — DocentAPI' };

const clerkReady = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

function NotConfigured({ message }: { message: string }) {
  return (
    <div className="wrap" style={{ padding: '60px 0', textAlign: 'center' }}>
      <p style={{ color: 'var(--fg-mute)' }}>{message}</p>
    </div>
  );
}

export default async function DashboardPage() {
  if (!clerkReady) {
    return <NotConfigured message="The dashboard isn't configured on this deployment yet." />;
  }

  const { userId } = await auth();
  if (!userId) redirect('/sign-in');

  if (!dbReady()) {
    return <NotConfigured message="Persistence isn't configured on this deployment yet." />;
  }

  const user = await currentUser();
  const email = user?.primaryEmailAddress?.emailAddress ?? user?.emailAddresses[0]?.emailAddress ?? '';

  const db = getDb();
  const { org } = await getOrCreateOrgForUser(db, userId, email);
  const myApis = await db.select().from(apis).where(eq(apis.orgId, org.id));
  const limit = limitsFor(org.plan).maxPersistentApis;
  const verifiedIds = await loadVerifiedApiIds(myApis.map((a) => a.id));

  return (
    <div className="wrap" style={{ padding: '40px 0', display: 'grid', gap: 24 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <span className="eyebrow">Dashboard</span>
          <h1 className="display" style={{ fontSize: 26 }}>{org.name}</h1>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <OrgBadge plan={org.plan} />
          <ManageBillingButton />
        </div>
      </header>

      <section>
        <h2 style={{ fontSize: 15, marginBottom: 12 }}>
          Your APIs{' '}
          <span className="chip" style={{ marginLeft: 8 }}>
            {myApis.length} / {limit}
          </span>
        </h2>
        {myApis.length === 0 ? (
          <div className="panel" style={{ padding: 20 }}>
            <p style={{ color: 'var(--fg-dim)' }}>
              No persistent APIs yet.{' '}
              <Link href="/app" className="text-link">
                Import one
              </Link>{' '}
              and save it to your account.
            </p>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            {myApis.map((api) => (
              <div
                key={api.id}
                className="panel"
                style={{ padding: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}
              >
                <div>
                  <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                    {api.name}
                    {verifiedIds.has(api.id) ? (
                      <span className="chip" style={{ color: 'var(--accent-green)', borderColor: 'rgba(67, 217, 163, 0.3)' }}>
                        Verified ✓
                      </span>
                    ) : (
                      <span className="chip">Not yet verified</span>
                    )}
                  </div>
                  <code className="mono" style={{ color: 'var(--fg-mute)', fontSize: 12 }}>/{api.slug}</code>
                </div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Link href={`/${api.slug}`} className="btn">
                    View page
                  </Link>
                  <Link href={`/mcp/${api.slug}`} className="btn">
                    MCP URL
                  </Link>
                  <RemoveApiButton slug={api.slug} name={api.name} />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
