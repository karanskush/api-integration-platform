import { SignUp } from '@clerk/nextjs';

const clerkReady = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

export default function SignUpPage() {
  return (
    <div style={{ display: 'grid', placeItems: 'center', padding: '60px 0' }}>
      {clerkReady ? (
        <SignUp />
      ) : (
        <p style={{ color: 'var(--fg-mute)' }}>Sign-up isn&apos;t configured on this deployment yet.</p>
      )}
    </div>
  );
}
