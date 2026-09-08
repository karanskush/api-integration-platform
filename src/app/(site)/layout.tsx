import { Show, UserButton } from '@clerk/nextjs';
import SiteFooter from '@/components/SiteFooter';
import '../landing.css';

// The marketing shell: /, /how-it-works, /pricing. Sells the instrument; every
// path out of here lands in the (product) console. landing.css is scoped to
// this group — the console never pays for the marketing styles, and
// how-it-works.css is loaded by that route alone.
const clerkReady = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header className="site-header">
        <div className="header-inner">
          <a className="brand" href="/">
            <span className="brand-mark" aria-hidden="true" />
            DocentAPI
          </a>
          <nav className="site-nav" aria-label="Primary">
            <a className="nav-link" href="/how-it-works">
              How it works
            </a>
            <a className="nav-link" href="/pricing">
              Pricing
            </a>
            {clerkReady ? (
              <>
                <Show when="signed-out">
                  <a className="nav-link" href="/sign-in">
                    Sign in
                  </a>
                  <a className="nav-cta" href="/sign-up">
                    Connect your API <span aria-hidden="true">→</span>
                  </a>
                </Show>
                <Show when="signed-in">
                  <a className="nav-link" href="/dashboard">
                    Dashboard
                  </a>
                  <UserButton />
                  {/* Step 01 is already done for this visitor — sending them
                      back to a signup form would be the nav arguing with the
                      session. */}
                  <a className="nav-cta" href="/app">
                    Connect your API <span aria-hidden="true">→</span>
                  </a>
                </Show>
              </>
            ) : (
              /* No Clerk keys configured: there is no signup to send anyone to,
                 so the console is the only honest destination. Mirrors the same
                 gate in the root layout. */
              <a className="nav-cta" href="/app">
                Open the console <span aria-hidden="true">→</span>
              </a>
            )}
          </nav>
        </div>
      </header>
      <main className="site-main">{children}</main>
      <SiteFooter />
    </>
  );
}
