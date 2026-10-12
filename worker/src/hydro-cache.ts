import { fetchHydrawise, presentZones, sendZone, type ZoneAction } from "./hydrawise";
import { jerusalemParts, pad2 } from "./time";
import type { ZoneView } from "./types";

/** statusschedule.php is limited to about 20 calls per 5 minutes. Stay near once a minute. */
export const MIN_STATUS_MS = 60_000;
const MAX_STATUS_MS = 10 * 60_000;
const CONTROLLER_MS = 10 * 60_000;
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

type Kv = Pick<KVNamespace, "get" | "put">;

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

async function readCache(kv: Kv): Promise<HydroCache> {
  try {
    const raw = await kv.get(KEY, "json");
    if (!raw || typeof raw !== "object") return emptyCache();
    const src = raw as Partial<HydroCache>;
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

async function writeCache(kv: Kv, cache: HydroCache): Promise<void> {
  try {
    await kv.put(KEY, JSON.stringify(cache));
  } catch {
    /* a missed write only risks one extra poll */
  }
}

/**
 * Seconds-or-timestamp `nextpoll` from Hydrawise, but never sooner than MIN_STATUS_MS.
 * There is no force flag: fresh=1 must not bypass this.
 */
export async function readHydrawise(
  kv: Kv,
  apiKey: string,
  nowMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<HydroCache> {
  const cache = await readCache(kv);
  if (nowMs < cache.nextPollAt) return cache;
  return refreshStatus(kv, apiKey, cache, nowMs, fetchImpl);
}

export async function recordZoneCommand(
  kv: Kv,
  apiKey: string,
  input: { action: ZoneAction; relayId: number; runSeconds?: number; suspendUntilEpoch?: number },
  nowMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ message?: string; message_type?: string }> {
  const result = await sendZone(apiKey, input, fetchImpl);
  let cache = await readCache(kv);
  if (result.message_type !== "error" && cache.schedule) patchRelay(cache.schedule, input);
  if (!cache.schedule || nowMs >= cache.nextPollAt) {
    cache = await refreshStatus(kv, apiKey, cache, nowMs, fetchImpl);
    if (result.message_type !== "error" && cache.schedule) patchRelay(cache.schedule, input);
    if (result.message_type !== "error") await writeCache(kv, cache);
    return result;
  }
  cache.nextPollAt = Math.max(cache.nextPollAt, nowMs + MIN_STATUS_MS);
  await writeCache(kv, cache);
  return result;
}

async function refreshStatus(
  kv: Kv,
  apiKey: string,
  cache: HydroCache,
  nowMs: number,
  fetchImpl: typeof fetch,
): Promise<HydroCache> {
  const claimed: HydroCache = { ...cache, nextPollAt: nowMs + MIN_STATUS_MS };
  await writeCache(kv, claimed);
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
    await writeCache(kv, saved);
    return saved;
  } catch (err) {
    const saved: HydroCache = {
      ...cache,
      nextPollAt: nowMs + MIN_STATUS_MS,
      stale: Boolean(cache.schedule),
      error: err instanceof Error ? err.message : "Hydrawise",
    };
    await writeCache(kv, saved);
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
