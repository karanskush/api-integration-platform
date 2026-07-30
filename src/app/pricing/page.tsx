import type { Metadata } from 'next';
import PricingTable from '@/components/PricingTable';

export const metadata: Metadata = { title: 'Pricing — DocentAPI' };

export default function PricingPage() {
  return (
    <div className="product-page wrap">
      <header className="page-head">
        <p className="eyebrow">Pricing</p>
        <h1 className="display">Free for public APIs. Forever.</h1>
        <p className="lead">
          Public pages are our distribution and your adoption — they cost you nothing. Plans are for
          private APIs, teams, and business-critical reliability.
        </p>
      </header>
      <PricingTable />
    </div>
  );
}
