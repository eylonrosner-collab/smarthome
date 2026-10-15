import { productionEphemeral, type Ephemeral } from "./ephemeral";
import { fetchHydrawise, presentZones, sendZone, type ZoneAction } from "./hydrawise";
import { jerusalemParts, pad2 } from "./time";
import type { ZoneView } from "./types";

/** statusschedule.php is limited to about 20 calls per 5 minutes. Stay near once a minute. */
export const MIN_STATUS_MS = 60_000;
const MAX_STATUS_MS = 10 * 60_000;
const CONTROLLER_MS = 10 * 60_000;
const KEEP_SEC = 6 * 60 * 60;
const KEY = "hydrawise_status";

export const HYDRO_UNAVAILABLE = "Hydrawise לא זמין כרגע, ואזורי ההשקיה יופיעו שוב אחרי חיבור מוצלח.";

export type HydroCache = {
  fetchedAt: number;
  nextPollAt: number;
  schedule: Record<string, unknown> | null;
  controller: Record<string, unknown>;
  controllerAt: number;
  stale: boolean;
  error?: string;
};

const flights = new WeakMap<Ephemeral, Promise<HydroCache>>();

export function nextStatusAt(nowMs: number, nextpoll: unknown): number {
  const floor = nowMs + MIN_STATUS_MS;
  const cap = nowMs + MAX_STATUS_MS;
  const n = Number(nextpoll);
  if (!Number.isFinite(n) || n <= 0) return floor;
  // Small values are a delay in seconds. A unix timestamp is already absolute.
  const suggested = n > 1_000_000_000 ? n * 1000 : nowMs + n * 1000;
  return Math.min(cap, Math.max(floor, suggested));
}

function emptyCache(): HydroCache {
  return { fetchedAt: 0, nextPollAt: 0, schedule: null, controller: {}, controllerAt: 0, stale: false };
}

async function readCache(store: Ephemeral): Promise<HydroCache> {
  try {
    const src = await store.get<Partial<HydroCache>>(KEY);
    if (!src || typeof src !== "object") return emptyCache();
    return {
      fetchedAt: Number(src.fetchedAt) || 0,
      nextPollAt: Number(src.nextPollAt) || 0,
      schedule: src.schedule && typeof src.schedule === "object" ? src.schedule : null,
      controller: src.controller && typeof src.controller === "object" ? src.controller : {},
      controllerAt: Number(src.controllerAt) || 0,
      stale: Boolean(src.stale),
      error: typeof src.error === "string" ? src.error : undefined,
    };
  } catch {
    return emptyCache();
  }
}

async function writeCache(store: Ephemeral, cache: HydroCache): Promise<void> {
  try {
    await store.put(KEY, cache, KEEP_SEC);
  } catch {
    /* a missed write only risks one extra poll */
  }
}

/**
 * Never sooner than MIN_STATUS_MS, and longer when Hydrawise sends nextpoll.
 * There is no force flag: fresh=1 must not bypass this. The timestamp lives in
 * the Cache API, not KV.
 */
export async function readHydrawise(
  apiKey: string,
  nowMs: number,
  fetchImpl: typeof fetch = fetch,
  store: Ephemeral = productionEphemeral,
): Promise<HydroCache> {
  const cache = await readCache(store);
  if (!apiKey) {
    if (nowMs < cache.nextPollAt) return cache;
    const saved: HydroCache = {
      ...cache,
      nextPollAt: nowMs + MIN_STATUS_MS,
      stale: Boolean(cache.schedule),
      error: cache.error || "missing api key",
    };
    await writeCache(store, saved);
    return saved;
  }
  if (nowMs < cache.nextPollAt) return cache;
  return refreshOnce(store, apiKey, cache, nowMs, fetchImpl);
}

export async function recordZoneCommand(
  apiKey: string,
  input: { action: ZoneAction; relayId: number; runSeconds?: number; suspendUntilEpoch?: number },
  nowMs: number,
  fetchImpl: typeof fetch = fetch,
  store: Ephemeral = productionEphemeral,
): Promise<{ message?: string; message_type?: string }> {
  const result = await sendZone(apiKey, input, fetchImpl);
  let cache = await readCache(store);
  if (result.message_type !== "error" && cache.schedule) patchRelay(cache.schedule, input);
  if (!cache.schedule || nowMs >= cache.nextPollAt) {
    cache = await refreshOnce(store, apiKey, cache, nowMs, fetchImpl);
    if (result.message_type !== "error" && cache.schedule) patchRelay(cache.schedule, input);
    if (result.message_type !== "error") await writeCache(store, cache);
    return result;
  }
  cache.nextPollAt = Math.max(cache.nextPollAt, nowMs + MIN_STATUS_MS);
  await writeCache(store, cache);
  return result;
}

function refreshOnce(
  store: Ephemeral,
  apiKey: string,
  cache: HydroCache,
  nowMs: number,
  fetchImpl: typeof fetch,
): Promise<HydroCache> {
  const existing = flights.get(store);
  if (existing) return existing;
  const job = refreshStatus(store, apiKey, cache, nowMs, fetchImpl).finally(() => {
    if (flights.get(store) === job) flights.delete(store);
  });
  flights.set(store, job);
  return job;
}

async function refreshStatus(
  store: Ephemeral,
  apiKey: string,
  cache: HydroCache,
  nowMs: number,
  fetchImpl: typeof fetch,
): Promise<HydroCache> {
  const claimed: HydroCache = { ...cache, nextPollAt: nowMs + MIN_STATUS_MS };
  await writeCache(store, claimed);
  try {
    const wantController = nowMs - cache.controllerAt >= CONTROLLER_MS;
    const { schedule, controller } = await fetchHydrawise(apiKey, fetchImpl, {
      controller: wantController,
      knownController: cache.controller,
    });
    const saved: HydroCache = {
      fetchedAt: nowMs,
      nextPollAt: nextStatusAt(nowMs, schedule.nextpoll),
      schedule,
      controller: controller && Object.keys(controller).length ? controller : cache.controller,
      controllerAt: wantController ? nowMs : cache.controllerAt,
      stale: false,
    };
    await writeCache(store, saved);
    return saved;
  } catch (err) {
    const saved: HydroCache = {
      ...cache,
      nextPollAt: nowMs + MIN_STATUS_MS,
      stale: Boolean(cache.schedule),
      error: err instanceof Error ? err.message : "Hydrawise",
    };
    await writeCache(store, saved);
    return saved;
  }
}

export function patchRelay(
  schedule: Record<string, unknown>,
  input: { action: ZoneAction; relayId: number; runSeconds?: number },
): void {
  const relays = Array.isArray(schedule.relays) ? (schedule.relays as Record<string, unknown>[]) : [];
  const zone = relays.find((relay) => Number(relay.relay_id) === input.relayId);
  if (!zone) return;
  if (input.action === "run") {
    zone.time = 1;
    zone.timestr = "now";
    if (input.runSeconds) zone.run = input.runSeconds;
    return;
  }
  zone.time = 0;
  zone.timestr = "";
  zone.run = 0;
}

export function zonesFromCache(cache: HydroCache, now: Date): ZoneView[] {
  if (!cache.schedule) return [];
  const zones = presentZones(cache.schedule, now);
  if (!cache.stale) return zones;
  const at = cache.fetchedAt ? new Date(cache.fetchedAt) : now;
  const parts = jerusalemParts(at);
  const label = `נתונים ישנים · ${pad2(parts.hour)}:${pad2(parts.minute)}`;
  return zones.map((zone) => ({ ...zone, staleLabel: label }));
}
