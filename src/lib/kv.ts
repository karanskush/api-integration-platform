import { Redis } from '@upstash/redis';
import type { ImportRecord } from './ir';

export type WaitlistEntry = { email: string; ts: number; source?: string };

export interface KV {
  getImport(id: string): Promise<ImportRecord | null>;
  setImport(rec: ImportRecord, ttlSecs: number): Promise<void>;
  // Companion to setImport/getImport: the raw spec bytes behind an ephemeral
  // import, kept out of ImportRecord itself so Phase 0's shape/tests are
  // untouched. Same key, same TTL — read by the claim/persist flow (persist.ts)
  // to compute the content hash and Blob snapshot; never read by Phase 0.
  getRawSpec(id: string): Promise<string | null>;
  setRawSpec(id: string, rawText: string, ttlSecs: number): Promise<void>;
  // Returns false when the email was already on the list.
  addWaitlist(entry: WaitlistEntry): Promise<boolean>;
}

const IMPORT_KEY = (id: string) => `spotcheck:import:${id}`;
const RAW_SPEC_KEY = (id: string) => `spotcheck:import:raw:${id}`;
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
    // Base64-wrapped, deliberately: @upstash/redis's get() auto-attempts
    // JSON.parse() on whatever it reads back, with no way to opt out. A raw
    // spec is itself JSON text for the (overwhelmingly common) JSON-format
    // case, so storing it verbatim meant get() silently handed back a PARSED
    // OBJECT instead of the original string — persist.ts's createHash(...).
    // update(rawText) then threw "data argument must be of type string",
    // crashing every claim of a JSON-format import. Base64 text can never be
    // valid JSON syntax on its own (no top-level production in the JSON
    // grammar matches an unquoted run of base64 characters), so this is
    // immune to the auto-parse regardless of what the original text looked
    // like — found live, in production, the first time this path ever ran
    // end-to-end (Clerk had blocked every earlier attempt this session).
    async getRawSpec(id) {
      const stored = await redis.get<string>(RAW_SPEC_KEY(id));
      // Migration window: entries written before the base64 wrap (≤24h TTL)
      // are raw spec text. A JSON-format one comes back auto-parsed as an
      // object — its original bytes are unrecoverable, so report "gone" and
      // let the claim route ask for a re-import. A non-JSON one comes back as
      // the raw string; base64's alphabet can't express spec syntax (:, {,
      // whitespace), so the regex cleanly separates it from wrapped values —
      // without this check Buffer.from would silently decode it to garbage.
      if (stored == null || typeof stored !== 'string') return null;
      return /^[A-Za-z0-9+/]+={0,2}$/.test(stored) ? Buffer.from(stored, 'base64').toString('utf8') : stored;
    },
    async setRawSpec(id, rawText, ttlSecs) {
      await redis.set(RAW_SPEC_KEY(id), Buffer.from(rawText, 'utf8').toString('base64'), { ex: ttlSecs });
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
  rawSpecs: Map<string, { text: string; expiresAt: number }>;
  emails: Set<string>;
  waitlist: WaitlistEntry[];
};

function memoryDriver(): KV {
  const g = globalThis as typeof globalThis & { __spotcheckKV?: MemoryStore };
  const initial: MemoryStore = { imports: new Map(), rawSpecs: new Map(), emails: new Set(), waitlist: [] };
  const store = (g.__spotcheckKV ??= initial);
  const { imports, rawSpecs, emails, waitlist } = store;

  const prune = () => {
    const now = Date.now();
    for (const [k, v] of imports) if (v.expiresAt <= now) imports.delete(k);
    for (const [k, v] of rawSpecs) if (v.expiresAt <= now) rawSpecs.delete(k);
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
    async getRawSpec(id) {
      const hit = rawSpecs.get(id);
      if (!hit) return null;
      if (hit.expiresAt <= Date.now()) {
        rawSpecs.delete(id);
        return null;
      }
      return hit.text;
    },
    async setRawSpec(id, rawText, ttlSecs) {
      rawSpecs.set(id, { text: rawText, expiresAt: Date.now() + ttlSecs * 1000 });
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
