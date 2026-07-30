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

const FROM = process.env.WAITLIST_FROM_EMAIL || 'DocentAPI <hello@docentapi.dev>';

// Deliberately one transactional email, not a drip sequence — this plumbing
// (Postgres row, QStash job, Resend send) is what a future sequence would
// reuse, not the sequence itself.
export async function sendWaitlistWelcomeEmail(to: string): Promise<void> {
  const resend = getResend();
  await resend.emails.send({
    from: FROM,
    to,
    subject: "You're on the DocentAPI waitlist",
    text: 'Thanks for joining the DocentAPI waitlist — we\'ll let you know as soon as your access is ready.',
  });
}

// Sent by the analyze-finalize job when the deep-analysis pipeline found
// something it couldn't confidently resolve on its own. `completeUrl` already
// carries the signed cross-device access token (analysisAccess.ts) — this
// email exists specifically so the link works even if it's opened somewhere
// with no Clerk session.
export async function sendClarificationNeededEmail(
  to: string,
  input: { apiName: string; completeUrl: string; questionCount: number },
): Promise<void> {
  const resend = getResend();
  const { apiName, completeUrl, questionCount } = input;
  const plural = questionCount === 1 ? 'question' : 'questions';
  await resend.emails.send({
    from: FROM,
    to,
    subject: `Finish setting up ${apiName} — ${questionCount} ${plural} left`,
    text: [
      `We went deep on ${apiName} — crawled the provider's own docs and ran a full field-by-field analysis.`,
      `There ${questionCount === 1 ? 'is' : 'are'} ${questionCount} ${plural} we couldn't confidently resolve on our own.`,
      '',
      `Finish it here: ${completeUrl}`,
      '',
      'This link works for 7 days, even if you open it on a different device than the one you started on.',
    ].join('\n'),
  });
}

// Sent by the analyze-finalize job when the deep-analysis pipeline resolved
// everything on its own — no clarification needed — or by the clarification
// answer route once the last open question is answered.
export async function sendAnalysisReadyEmail(
  to: string,
  input: { apiName: string; pageUrl: string; unresolvedCount?: number },
): Promise<void> {
  const resend = getResend();
  const { apiName, pageUrl, unresolvedCount = 0 } = input;
  await resend.emails.send({
    from: FROM,
    to,
    subject: `${apiName} is ready`,
    text: [
      `The deep analysis of ${apiName} is complete — every field has been traced, and the provider's own docs`,
      "were folded in wherever they helped explain something the spec alone didn't.",
      // Naming the gaps rather than quietly shipping a record that reads as
      // complete. A skipped question is an honest unknown, and the owner should
      // know it stayed one.
      ...(unresolvedCount > 0
        ? [
            '',
            `${unresolvedCount} question${unresolvedCount === 1 ? '' : 's'} went unanswered, so ${
              unresolvedCount === 1 ? 'that field is' : 'those fields are'
            } marked unresolved rather than guessed at. You can still answer ${
              unresolvedCount === 1 ? 'it' : 'them'
            } later.`,
          ]
        : []),
      '',
      `View it here: ${pageUrl}`,
    ].join('\n'),
  });
}
