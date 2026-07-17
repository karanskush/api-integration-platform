import { Resend } from 'resend';

// Same lazy xReady()/hard-fail-in-prod shape as kv.ts/db.ts/stripe.ts.
export function emailReady(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

let instance: Resend | null = null;

function getResend(): Resend {
  if (!instance) {
    if (!emailReady()) {
      throw new Error('RESEND_API_KEY is not set — configure Resend (provision via the Vercel Marketplace) to send transactional email.');
    }
    instance = new Resend(process.env.RESEND_API_KEY!);
  }
  return instance;
}

const FROM = process.env.WAITLIST_FROM_EMAIL || 'Spotcheck <hello@spotcheck.dev>';

// Deliberately one transactional email, not a drip sequence — this plumbing
// (Postgres row, QStash job, Resend send) is what a future sequence would
// reuse, not the sequence itself.
export async function sendWaitlistWelcomeEmail(to: string): Promise<void> {
  const resend = getResend();
  await resend.emails.send({
    from: FROM,
    to,
    subject: "You're on the Spotcheck waitlist",
    text: 'Thanks for joining the Spotcheck waitlist — we\'ll let you know as soon as your access is ready.',
  });
}
