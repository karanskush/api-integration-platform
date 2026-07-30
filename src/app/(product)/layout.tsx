import { Show, UserButton } from '@clerk/nextjs';
import SiteFooter from '@/components/SiteFooter';
import ProductNav from '@/components/product/ProductNav';

// The console shell: importing, analysing, managing. Same instrument voice as
// the marketing site, none of the story — the header answers "where am I and
// where can I go" and nothing else. Generated API pages (/[slug], /p/[id])
// also live here: they are the product's output, and their visitors should
// see the way into the tool, not a pitch.
const clerkReady = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

export default function ProductLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header className="site-header">
        <div className="header-inner">
          <div className="app-brand-group">
            <a className="brand" href="/">
              <span className="brand-mark" aria-hidden="true" />
              DocentAPI
            </a>
            <span className="console-tag">console</span>
          </div>
          <div className="app-aside">
            <ProductNav />
            {clerkReady && (
              <>
                <Show when="signed-out">
                  <a className="nav-link" href="/sign-in">
                    Sign in
                  </a>
                </Show>
                <Show when="signed-in">
                  <UserButton />
                </Show>
              </>
            )}
          </div>
        </div>
      </header>
      <main className="site-main">{children}</main>
      <SiteFooter />
    </>
  );
}
