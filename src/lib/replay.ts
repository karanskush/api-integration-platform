// One-shot replay guard for signed requests.
//
// A signature over `${timestamp}.${body}` plus a freshness window bounds replay
// to that window. This closes it inside the window as well, by remembering
// signatures already processed. SET NX is the whole mechanism: whoever creates
// the key wins, everyone after it loses.
//
// Best-effort by design. Without Redis (local dev, or production before Upstash
// is provisioned) this returns "fresh" for everything, leaving the timestamp
// window as the only bound — the same guarantee GitHub's own webhook signing
// gives. It must never be the *only* thing standing between a caller and a
// write, and it never is: signature verification always runs first.

import { Redis } from '@upstash/redis';
import { hasRedis } from './kv';

const DEFAULT_TTL_SECONDS = 900; // comfortably longer than any signing window

let client: Redis | null = null;

function redis(): Redis {
  if (!client) client = Redis.fromEnv();
  return client;
}

// Returns true when this key had not been seen before (i.e. proceed), false
// when it is a replay. Storage errors resolve to true rather than blocking a
// legitimate request on a cache outage — availability beats a guard that is
// already the second line of defence.
export async function markSeen(key: string, ttlSeconds = DEFAULT_TTL_SECONDS): Promise<boolean> {
  if (!hasRedis()) return true;
  try {
    const stored = await redis().set(key, '1', { nx: true, ex: ttlSeconds });
    return stored === 'OK';
  } catch {
    return true;
  }
}
