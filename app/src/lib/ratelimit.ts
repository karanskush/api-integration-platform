import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { hasRedis } from './kv';

export type Limiter = {
  limit(key: string): Promise<{ success: boolean; reset: number }>;
};

type Config = { limit: number; windowSec: number };

const limiters = new Map<string, Limiter>();

function upstashLimiter(scope: string, cfg: Config): Limiter {
  const rl = new Ratelimit({
    redis: Redis.fromEnv(),
    limiter: Ratelimit.slidingWindow(cfg.limit, `${cfg.windowSec} s`),
    prefix: `spotcheck:rl:${scope}`,
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
  let l = limiters.get(scope);
  if (!l) {
    l = hasRedis() ? upstashLimiter(scope, cfg) : memoryLimiter(cfg);
    limiters.set(scope, l);
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
