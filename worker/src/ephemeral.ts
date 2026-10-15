/**
 * Short-lived state (Hydrawise, Tuya, rate-limit timestamps) stays out of KV.
 * The free plan allows 1,000 KV writes per day. Memory covers this isolate;
 * the Cache API shares a colo so other isolates reuse the same timestamp.
 * A missed cache entry only risks one extra upstream call.
 */

export type Ephemeral = {
  get<T>(key: string): Promise<T | null>;
  put(key: string, value: unknown, ttlSeconds: number): Promise<void>;
};

type MemRow = { expires: number; json: string };

const memory = new Map<string, MemRow>();
const DURABLE_MEM_MS = 5_000;
const DURABLE_TTL_SEC = 60 * 60;
const CACHE_HOST = "https://smarthome.eylonrosner.workers.dev/ephemeral/";

export function memoryEphemeral(): Ephemeral {
  const local = new Map<string, MemRow>();
  return {
    async get<T>(key: string): Promise<T | null> {
      return readRow<T>(local.get(key));
    },
    async put(key: string, value: unknown, ttlSeconds: number): Promise<void> {
      local.set(key, row(value, ttlSeconds * 1000));
    },
  };
}

export const productionEphemeral: Ephemeral = {
  async get<T>(key: string): Promise<T | null> {
    const local = readRow<T>(memory.get(key));
    if (local != null) return local;
    const remote = await cacheGet<T>(key);
    if (remote === undefined) return null;
    memory.set(key, row(remote, 60_000));
    return remote;
  },
  async put(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    memory.set(key, row(value, ttlSeconds * 1000));
    await cachePut(key, value, ttlSeconds);
  },
};

/** Rules, prefs, and activity. KV is the durable copy; Cache API serves the hot reads. */
export async function readThrough<T>(key: string, load: () => Promise<T>): Promise<T> {
  if (!cacheApiAvailable()) return load();
  const local = readRow<T>(memory.get(durableKey(key)));
  if (local != null) return local;
  const remote = await cacheGet<T>(durableKey(key));
  if (remote !== undefined) {
    memory.set(durableKey(key), row(remote, DURABLE_MEM_MS));
    return remote;
  }
  const value = await load();
  await remember(key, value);
  return value;
}

export async function remember<T>(key: string, value: T): Promise<void> {
  if (!cacheApiAvailable()) return;
  memory.set(durableKey(key), row(value, DURABLE_MEM_MS));
  await cachePut(durableKey(key), value, DURABLE_TTL_SEC);
}

function durableKey(key: string): string {
  return `durable:${key}`;
}

function row(value: unknown, ttlMs: number): MemRow {
  return { expires: Date.now() + ttlMs, json: JSON.stringify(value) };
}

function readRow<T>(entry: MemRow | undefined): T | null {
  if (!entry || Date.now() >= entry.expires) return null;
  return JSON.parse(entry.json) as T;
}

function cacheApiAvailable(): boolean {
  return typeof caches !== "undefined" && typeof caches.default !== "undefined";
}

function cacheRequest(key: string): Request {
  return new Request(`${CACHE_HOST}${encodeURIComponent(key)}`, { method: "GET" });
}

async function cacheGet<T>(key: string): Promise<T | undefined> {
  if (!cacheApiAvailable()) return undefined;
  try {
    const hit = await caches.default.match(cacheRequest(key));
    if (!hit) return undefined;
    const body = (await hit.json()) as { v?: T };
    if (!body || !("v" in body)) return undefined;
    return body.v as T;
  } catch {
    return undefined;
  }
}

async function cachePut(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  if (!cacheApiAvailable()) return;
  try {
    const response = new Response(JSON.stringify({ v: value }), {
      headers: {
        "content-type": "application/json",
        "cache-control": `public, max-age=${Math.max(60, Math.ceil(ttlSeconds))}`,
      },
    });
    await caches.default.put(cacheRequest(key), response);
  } catch {
    /* memory still holds this isolate */
  }
}
