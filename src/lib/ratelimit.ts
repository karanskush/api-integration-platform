import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { hasRedis } from './kv';

export type Limiter = {
  limit(key: string): Promise<{ success: boolean; reset: number }>;
};

type Config = { limit: number; windowSec: number };

// Cached by scope *and* config. Keying on scope alone silently pins the first
// config ever seen for that scope: an org upgrading its plan would keep the
// old daily MCP ceiling until the lambda cold-starts, because the cached
// limiter was built with the previous limit.
const limiters = new Map<string, Limiter>();

// A scope is a limiter *family* ('mcp-credits'), never a per-tenant string —
// the tenant goes in the .limit(key) argument. That keeps this map bounded by
// families × distinct configs instead of growing one entry per org forever.
// The cap below is a backstop in case a caller forgets.
const MAX_CACHED_LIMITERS = 256;

function upstashLimiter(scope: string, cfg: Config): Limiter {
  const rl = new Ratelimit({
    redis: Redis.fromEnv(),
    limiter: Ratelimit.slidingWindow(cfg.limit, `${cfg.windowSec} s`),
    prefix: `docentapi:rl:${scope}`,
  });
  return {
    async limit(key) {
      const res = await rl.limit(key);
      return { success: res.success, reset: res.reset };
    },
  };
}

// Fixed-window in-memory fallback for local dev.
function memoryLimiter(cfg: Config): Limiter {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return {
    async limit(key) {
      const now = Date.now();
      let w = windows.get(key);
      if (!w || w.resetAt <= now) {
        w = { count: 0, resetAt: now + cfg.windowSec * 1000 };
        windows.set(key, w);
        if (windows.size > 10_000) {
          for (const [k, v] of windows) if (v.resetAt <= now) windows.delete(k);
        }
      }
      w.count++;
      return { success: w.count <= cfg.limit, reset: w.resetAt };
    },
  };
}

export function getLimiter(scope: string, cfg: Config): Limiter {
  const cacheKey = `${scope}|${cfg.limit}|${cfg.windowSec}`;
  let l = limiters.get(cacheKey);
  if (!l) {
    if (limiters.size >= MAX_CACHED_LIMITERS) {
      // Insertion-ordered: drop the oldest entry. Evicting an Upstash limiter
      // loses nothing (its counters live in Redis); evicting the dev-only
      // memory limiter just resets a local window.
      const oldest = limiters.keys().next().value;
      if (oldest !== undefined) limiters.delete(oldest);
    }
    l = hasRedis() ? upstashLimiter(scope, cfg) : memoryLimiter(cfg);
    limiters.set(cacheKey, l);
  }
  return l;
}

export function tooMany(reset: number): Response {
  return Response.json(
    { error: 'Rate limit exceeded' },
    {
      status: 429,
      headers: { 'Retry-After': String(Math.max(1, Math.ceil((reset - Date.now()) / 1000))) },
    },
  );
}
