import { SignIn } from '@clerk/nextjs';

const clerkReady = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

export default function SignInPage() {
  return (
    <div style={{ display: 'grid', placeItems: 'center', padding: '60px 0' }}>
      {clerkReady ? (
        <SignIn />
      ) : (
        <p style={{ color: 'var(--fg-mute)' }}>Sign-in isn&apos;t configured on this deployment yet.</p>
      )}
    </div>
  );
}
