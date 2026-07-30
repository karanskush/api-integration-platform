import { auth } from '@clerk/nextjs/server';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import AnalyzeForm from '@/components/AnalyzeForm';

export const metadata: Metadata = { title: 'Deep analysis — DocentAPI' };

// Same clerkReady()/hard-redirect gate as dashboard/page.tsx — this page
// requires a real account from the first request (see /api/apis/analyze's
// header comment for why), unlike the anonymous /app import flow.
const clerkReady = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

export default async function AnalyzePage() {
  if (!clerkReady) {
    return (
      <div className="wrap" style={{ padding: '60px 0', textAlign: 'center' }}>
        <p style={{ color: 'var(--fg-mute)' }}>Deep analysis isn&apos;t configured on this deployment yet.</p>
      </div>
    );
  }

  const { userId } = await auth();
  if (!userId) redirect('/sign-in');

  return (
    <div className="wrap" style={{ padding: '40px 0', display: 'grid', gap: 20, maxWidth: 640, margin: '0 auto' }}>
      <header>
        <span className="eyebrow">Deep analysis</span>
        <h1 className="display" style={{ fontSize: 26 }}>
          Submit an API for a real, verified integration
        </h1>
        <p style={{ color: 'var(--fg-dim)', fontSize: 13.5, marginTop: 8 }}>
          Paste a spec and, if you have them, links to the provider&apos;s own docs. We take real time
          to go deep on every field and body — and if something can&apos;t be figured out automatically,
          we&apos;ll email you to fill in the gap.
        </p>
      </header>
      <AnalyzeForm />
    </div>
  );
}
