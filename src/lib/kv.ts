import { Redis } from '@upstash/redis';
import type { ImportRecord } from './ir';

export type WaitlistEntry = { email: string; ts: number; source?: string };

export interface KV {
  getImport(id: string): Promise<ImportRecord | null>;
  setImport(rec: ImportRecord, ttlSecs: number): Promise<void>;
  // Returns false when the email was already on the list.
  addWaitlist(entry: WaitlistEntry): Promise<boolean>;
}

const IMPORT_KEY = (id: string) => `spotcheck:import:${id}`;
const WAITLIST_LIST = 'spotcheck:waitlist';
const WAITLIST_SET = 'spotcheck:waitlist:emails';

function upstashDriver(): KV {
  const redis = Redis.fromEnv();
  return {
    async getImport(id) {
      return (await redis.get<ImportRecord>(IMPORT_KEY(id))) ?? null;
    },
    async setImport(rec, ttlSecs) {
      await redis.set(IMPORT_KEY(rec.id), JSON.stringify(rec), { ex: ttlSecs });
    },
    async addWaitlist(entry) {
      const added = await redis.sadd(WAITLIST_SET, entry.email);
      if (added === 0) return false;
      await redis.lpush(WAITLIST_LIST, JSON.stringify(entry));
      return true;
    },
  };
}

// Local-dev fallback: dies on reload, single-instance only. Production
// requires Upstash — /api/import fails loudly there without it (see kv()).
// State hangs off globalThis because Next bundles the RSC layer and route
// handlers separately — module scope alone would give each layer its own Map.
type MemoryStore = {
  imports: Map<string, { rec: ImportRecord; expiresAt: number }>;
  emails: Set<string>;
  waitlist: WaitlistEntry[];
};

function memoryDriver(): KV {
  const g = globalThis as typeof globalThis & { __spotcheckKV?: MemoryStore };
  const initial: MemoryStore = { imports: new Map(), emails: new Set(), waitlist: [] };
  const store = (g.__spotcheckKV ??= initial);
  const { imports, emails, waitlist } = store;

  const prune = () => {
    const now = Date.now();
    for (const [k, v] of imports) if (v.expiresAt <= now) imports.delete(k);
  };
  setInterval(prune, 60_000).unref?.();

  return {
    async getImport(id) {
      const hit = imports.get(id);
      if (!hit) return null;
      if (hit.expiresAt <= Date.now()) {
        imports.delete(id);
        return null;
      }
      return hit.rec;
    },
    async setImport(rec, ttlSecs) {
      imports.set(rec.id, { rec, expiresAt: Date.now() + ttlSecs * 1000 });
    },
    async addWaitlist(entry) {
      if (emails.has(entry.email)) return false;
      emails.add(entry.email);
      waitlist.push(entry);
      return true;
    },
  };
}

export function hasRedis(): boolean {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

// True when a usable store exists: Upstash anywhere, or memory outside Vercel prod.
export function storageReady(): boolean {
  return hasRedis() || !(process.env.NODE_ENV === 'production' && process.env.VERCEL);
}

let instance: KV | null = null;

export function kv(): KV {
  if (!instance) {
    if (hasRedis()) {
      instance = upstashDriver();
    } else {
      if (process.env.NODE_ENV === 'production' && process.env.VERCEL) {
        throw new Error('Upstash Redis is required in production: set UPSTASH_REDIS_REST_URL/TOKEN');
      }
      instance = memoryDriver();
    }
  }
  return instance;
}
