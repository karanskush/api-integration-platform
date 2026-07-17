import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

// Next 16 renamed middleware.ts -> proxy.ts; the installed @clerk/nextjs
// (>=7) recognizes this file at src/proxy.ts.

const clerkReady = Boolean(process.env.CLERK_SECRET_KEY && process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

const isProtectedRoute = createRouteMatcher(['/dashboard(.*)', '/api/apis(.*)', '/api/billing(.*)']);

// Without Clerk credentials configured, every request passes through
// untouched — the anonymous Phase 0 flow (import/playground/MCP) must never
// depend on Clerk being set up. Mirrors kv.ts/stripe.ts's xReady() gate.
// `/app`, `/p/[id]`, `/mcp/[id]`, `/[slug]`, `/mcp/[slug]`, `/api/import`,
// `/api/proxy`, `/api/waitlist`, and `/pricing` are never protected either
// way — "no signup before the magic moment" holds regardless of auth state.
export default clerkReady
  ? clerkMiddleware(async (auth, req) => {
      if (isProtectedRoute(req)) await auth.protect();
    })
  : () => NextResponse.next();

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
