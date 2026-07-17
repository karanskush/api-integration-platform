import { Client } from '@upstash/qstash';

// Same lazy xReady()/hard-fail-in-prod shape as kv.ts/db.ts/stripe.ts. The
// only queue consumer Phase 1 needs is the waitlist welcome email — single
// step, no pause/resume, no multi-step state, so plain QStash is enough;
// Workflow DevKit's actual fit is Phase 2's multi-step probe orchestration.
export function queueReady(): boolean {
  return Boolean(process.env.QSTASH_TOKEN);
}

let instance: Client | null = null;

function getClient(): Client {
  if (!instance) {
    if (!queueReady()) {
      throw new Error('QSTASH_TOKEN is not set — configure Upstash QStash to enqueue jobs.');
    }
    instance = new Client({ token: process.env.QSTASH_TOKEN! });
  }
  return instance;
}

function jobUrl(path: string): string {
  const origin = process.env.PUBLIC_APP_ORIGIN?.replace(/\/$/, '');
  if (!origin) {
    throw new Error('PUBLIC_APP_ORIGIN must be set to enqueue jobs — QStash needs an absolute callback URL.');
  }
  return `${origin}${path}`;
}

export async function publishJob(path: string, body: unknown): Promise<void> {
  const client = getClient();
  await client.publishJSON({ url: jobUrl(path), body });
}
