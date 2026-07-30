import { auth } from '@clerk/nextjs/server';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import AnalyzeForm from '@/components/product/AnalyzeForm';

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
        <span className="eyebrow">Deep analysis · the second pass</span>
        <h1 className="display" style={{ fontSize: 26 }}>
          Go deep on this API
        </h1>
        <p style={{ color: 'var(--fg-dim)', fontSize: 13.5, marginTop: 8 }}>
          The instant import reads the spec alone. This pass takes real time: we crawl the
          provider&apos;s own docs and go field by field. You&apos;ll land on the API&apos;s workspace right
          away and can watch the analysis run there — we&apos;ll email you when it&apos;s verified, or
          sooner if we need you to fill in a gap we couldn&apos;t close ourselves.
        </p>
      </header>
      <AnalyzeForm />
    </div>
  );
}
