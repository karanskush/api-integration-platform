import type { Metadata } from 'next';
import PricingTable from '@/components/PricingTable';

export const metadata: Metadata = { title: 'Pricing — Spotcheck' };

export default function PricingPage() {
  return (
    <div className="wrap" style={{ padding: '40px 0' }}>
      <div style={{ marginBottom: 24 }}>
        <span className="eyebrow">Pricing</span>
        <h1 className="display" style={{ fontSize: 26 }}>Free for public APIs. Forever.</h1>
        <p className="lead">
          Public pages are our distribution and your adoption — they cost you nothing. Plans are for
          private APIs, teams, and business-critical reliability.
        </p>
      </div>
      <PricingTable />
    </div>
  );
}
