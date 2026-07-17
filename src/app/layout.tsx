import { ClerkProvider, Show, UserButton } from '@clerk/nextjs';
import type { Metadata, Viewport } from 'next';
import { Geist, Instrument_Sans, JetBrains_Mono } from 'next/font/google';
import './globals.css';

// Without Clerk keys configured, auth UI is skipped entirely — the anonymous
// Phase 0 flow must never depend on Clerk being set up. Mirrors kv.ts's
// xReady() convention. See src/proxy.ts for the matching middleware gate.
const clerkReady = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

const geist = Geist({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-geist',
});

const instrumentSans = Instrument_Sans({
  subsets: ['latin'],
  weight: ['500', '600'],
  variable: '--font-instrument-sans',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-jetbrains-mono',
});

// Same mark as the landing page favicon.
const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%2305080a'/%3E%3Crect x='7.5' y='7.5' width='17' height='17' rx='4' fill='none' stroke='%234fc8e8' stroke-width='2'/%3E%3Crect x='13' y='13' width='6' height='6' rx='1.5' fill='%234fc8e8'/%3E%3C/svg%3E";

export const metadata: Metadata = {
  title: 'Spotcheck — your API, agent-ready in 60 seconds',
  description:
    'Paste an OpenAPI spec, Postman collection, or cURL command. Get a live integration page, a BYOK playground, and a hosted MCP server.',
  icons: { icon: FAVICON },
};

export const viewport: Viewport = {
  themeColor: '#05080a',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const page = (
    <html
      lang="en"
      className={`${geist.variable} ${instrumentSans.variable} ${jetbrainsMono.variable}`}
    >
      <body>
        <header className="site-header">
          <div className="header-inner">
            <a className="brand" href="/">
              <span className="brand-mark" aria-hidden="true" />
              Spotcheck
            </a>
            <nav className="site-nav" aria-label="Primary">
              <a className="nav-link" href="/#demo">
                Demo
              </a>
              <a className="nav-link" href="/#how">
                What you get
              </a>
              <a className="nav-link" href="/#score">
                Score
              </a>
              <a className="nav-link" href="/pricing">
                Pricing
              </a>
              <a className="nav-link nav-app" href="/app">
                App
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
                Open app <span aria-hidden="true">→</span>
              </a>
            </nav>
          </div>
        </header>
        <main className="site-main">{children}</main>
        <footer className="site-footer">
          <div className="footer-inner">
            <span>Spotcheck · behavior-verified API integration</span>
            <span className="footer-links">
              <a href="https://github.com/karanskush/api-integration-platform">GitHub</a>
              <a href="mailto:hello@spotcheck.dev">Contact</a>
            </span>
          </div>
        </footer>
      </body>
    </html>
  );

  return clerkReady ? <ClerkProvider>{page}</ClerkProvider> : page;
}
