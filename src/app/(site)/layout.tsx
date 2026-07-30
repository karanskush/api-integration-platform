import { Show, UserButton } from '@clerk/nextjs';
import SiteFooter from '@/components/SiteFooter';
import '../landing.css';

// The marketing shell: /, /pricing. Sells the instrument; every path out of
// here lands in the (product) console. landing.css is scoped to this group —
// the console never pays for the chapter styles.
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
            <a className="nav-link" href="/#how">
              What you get
            </a>
            <a className="nav-link" href="/#score">
              Score
            </a>
            <a className="nav-link" href="/pricing">
              Pricing
            </a>
            {clerkReady && (
              <>
                <Show when="signed-out">
                  <a className="nav-link" href="/sign-in">
                    Sign in
                  </a>
                </Show>
                <Show when="signed-in">
                  <a className="nav-link" href="/dashboard">
                    Dashboard
                  </a>
                  <UserButton />
                </Show>
              </>
            )}
            <a className="nav-cta" href="/app">
              Open the console <span aria-hidden="true">→</span>
            </a>
          </nav>
        </div>
      </header>
      <main className="site-main">{children}</main>
      <SiteFooter />
    </>
  );
}
