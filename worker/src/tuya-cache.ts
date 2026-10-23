import { productionEphemeral, type Ephemeral } from "./ephemeral";
import { deviceTitle, presentDevice } from "./present";
import {
  TuyaClient,
  TUYA_QUOTA_MESSAGE,
  isQuotaError,
  tuyaQuotaActive,
} from "./tuya";
import type { DeviceView, Env, TuyaDevice } from "./types";

/** Dashboard list+status sweep. fresh=1 does not bypass this. */
export const TUYA_SWEEP_MS = 30 * 60_000;
/** Names, categories, gang labels, and AC/IR links. */
export const TUYA_META_MS = 24 * 60 * 60_000;
/** Cron sensor readings. Matches the 5-minute schedule. */
export const TUYA_SENSOR_MS = 5 * 60_000;

const META_KEY = "tuya_meta";
const STATUS_KEY = "tuya_status";
const KEEP_SEC = 24 * 60 * 60;
const STALE = "Tuya לא רוענן, מוצג המצב האחרון.";

export type SensorRef = { deviceId?: string; deviceName?: string };

export type TuyaScope =
  | { mode: "dashboard" }
  | { mode: "sensors"; refs: SensorRef[] };

type MetaCache = {
  fetchedAt: number;
  devices: TuyaDevice[];
  gangNames: Record<string, Record<string, string>>;
  links: Record<string, { infraredId?: string; remoteId?: string }>;
};

type StatusEntry = { at: number; status: Record<string, unknown> | null };

type StatusCache = {
  /** Last dashboard-wide status fetch. Sensor batches do not move this. */
  fullAt: number;
  byId: Record<string, StatusEntry>;
};

export async function loadTuyaDevices(
  env: Env,
  now: Date,
  scope: TuyaScope = { mode: "dashboard" },
  store: Ephemeral = productionEphemeral,
  existing?: TuyaClient,
): Promise<{ devices: DeviceView[]; errors: string[] }> {
  const nowMs = now.getTime();
  if (scope.mode === "sensors" && !scope.refs.length) {
    return { devices: await presentCached(store, now, []), errors: [] };
  }
  if (!env.TUYA_ACCESS_ID || !env.TUYA_ACCESS_SECRET) {
    const devices = await presentCached(store, now, []);
    if (devices.length) return { devices, errors: [STALE] };
    return { devices: [], errors: ["Tuya: חסרים מפתחות"] };
  }
  if (await tuyaQuotaActive(store, nowMs)) {
    return { devices: await presentCached(store, now, idsFrom(scope)), errors: [TUYA_QUOTA_MESSAGE] };
  }

  const client = existing ?? new TuyaClient({
    accessId: env.TUYA_ACCESS_ID,
    accessSecret: env.TUYA_ACCESS_SECRET,
    base: env.TUYA_BASE,
    store,
    now: () => nowMs,
  });

  if (scope.mode === "sensors") return loadSensorStatus(client, store, scope.refs, now);

  let meta = await readMeta(store);
  let status = await readStatus(store);
  const errors: string[] = [];
  try {
    if (!meta || nowMs - meta.fetchedAt >= TUYA_META_MS) {
      meta = await refreshMeta(client, nowMs);
      await writeMeta(store, meta);
    }
    if (!status || nowMs - status.fullAt >= TUYA_SWEEP_MS) {
      const ids = meta.devices.map((device) => String(device.id));
      status = await refreshAll(client, ids, status, nowMs, errors);
      await writeStatus(store, status);
    }
  } catch (err) {
    return failed(err, await presentCached(store, now, []));
  }
  return { devices: present(meta, status, now, []), errors };
}

async function loadSensorStatus(client: TuyaClient, store: Ephemeral, refs: SensorRef[], now: Date): Promise<{ devices: DeviceView[]; errors: string[] }> {
  const nowMs = now.getTime();
  const meta = await readMeta(store);
  let status = await readStatus(store);
  const ids = resolveIds(refs, meta);
  const stale = ids.filter((id) => {
    const entry = status?.byId[id];
    return !entry || nowMs - entry.at >= TUYA_SENSOR_MS;
  });
  if (!stale.length) return { devices: present(meta, status, now, ids), errors: [] };
  const byId: StatusCache["byId"] = { ...(status?.byId ?? {}) };
  try {
    const batch = await client.batchStatus(stale);
    if (batch) {
      for (const id of stale) {
        byId[id] = { at: nowMs, status: batch.has(id) ? (batch.get(id) ?? null) : (byId[id]?.status ?? null) };
      }
    } else {
      for (const id of stale) {
        try {
          byId[id] = { at: nowMs, status: await client.deviceStatus(id) };
        } catch (err) {
          if (isQuotaError(err)) throw err;
        }
      }
    }
  } catch (err) {
    return failed(err, present(meta, status, now, ids));
  }
  status = { fullAt: status?.fullAt ?? 0, byId };
  await writeStatus(store, status);
  return { devices: present(meta, status, now, ids), errors: [] };
}

async function refreshAll(
  client: TuyaClient,
  ids: string[],
  previous: StatusCache | null,
  nowMs: number,
  errors: string[],
): Promise<StatusCache> {
  const byId: StatusCache["byId"] = { ...(previous?.byId ?? {}) };
  const batch = await client.batchStatus(ids);
  if (batch) {
    for (const id of ids) {
      byId[id] = { at: nowMs, status: batch.has(id) ? (batch.get(id) ?? null) : (byId[id]?.status ?? null) };
    }
    return { fullAt: nowMs, byId };
  }
  for (const id of ids) {
    try {
      byId[id] = { at: nowMs, status: await client.deviceStatus(id) };
    } catch (err) {
      if (isQuotaError(err)) throw err;
      errors.push(`${id}: סטטוס`);
    }
  }
  return { fullAt: nowMs, byId };
}

async function refreshMeta(client: TuyaClient, nowMs: number): Promise<MetaCache> {
  const devices = (await client.listDevices()) as TuyaDevice[];
  const gangNames: Record<string, Record<string, string>> = {};
  for (const device of devices) {
    const category = String(device.category || "");
    if (category !== "kg" && category !== "tgkg") continue;
    gangNames[String(device.id)] = await client.gangNames(String(device.id));
  }
  const linked = await linkAirConditioners(client, devices);
  const links: MetaCache["links"] = {};
  for (const [id, link] of linked) links[id] = link;
  return { fetchedAt: nowMs, devices, gangNames, links };
}

function failed(err: unknown, devices: DeviceView[]): { devices: DeviceView[]; errors: string[] } {
  if (isQuotaError(err)) return { devices, errors: [TUYA_QUOTA_MESSAGE] };
  if (devices.length) return { devices, errors: [STALE] };
  const message = err instanceof Error ? err.message : "שגיאה";
  return { devices: [], errors: [`Tuya: ${message}`] };
}

function idsFrom(scope: TuyaScope): string[] {
  if (scope.mode !== "sensors") return [];
  return scope.refs.map((ref) => ref.deviceId).filter((id): id is string => Boolean(id));
}

function resolveIds(refs: SensorRef[], meta: MetaCache | null): string[] {
  const ids = new Set<string>();
  for (const ref of refs) {
    if (ref.deviceId) {
      ids.add(ref.deviceId);
      continue;
    }
    const name = (ref.deviceName || "").trim().toLowerCase();
    if (!name || !meta) continue;
    const found = meta.devices.find((device) => {
      const title = `${device.customName || ""} ${device.name || ""}`.trim().toLowerCase();
      return title === name || (device.name || "").trim().toLowerCase() === name;
    });
    if (found?.id) ids.add(String(found.id));
  }
  return [...ids];
}

async function presentCached(store: Ephemeral, now: Date, extraIds: string[]): Promise<DeviceView[]> {
  return present(await readMeta(store), await readStatus(store), now, extraIds);
}

function present(meta: MetaCache | null, status: StatusCache | null, now: Date, extraIds: string[]): DeviceView[] {
  const devices = meta?.devices ? [...meta.devices] : [];
  const known = new Set(devices.map((device) => String(device.id)));
  for (const id of extraIds) {
    if (known.has(id)) continue;
    known.add(id);
    devices.push(shell(id, status?.byId[id]?.status ?? null));
  }
  return devices.map((device) => {
    const id = String(device.id);
    return presentDevice(device, status?.byId[id]?.status ?? null, meta?.gangNames[id] ?? {}, now, meta?.links[id]);
  });
}

function shell(id: string, status: Record<string, unknown> | null): TuyaDevice {
  const soil = Boolean(status && ["humidity_value", "soil_humidity", "humidity", "moisture", "soilhumidity"].some((code) => code in status));
  return { id, name: id, category: soil ? "zwjcy" : "" };
}

async function readMeta(store: Ephemeral): Promise<MetaCache | null> {
  try {
    const raw = await store.get<MetaCache>(META_KEY);
    if (!raw?.devices || !Array.isArray(raw.devices)) return null;
    return {
      fetchedAt: Number(raw.fetchedAt) || 0,
      devices: raw.devices,
      gangNames: raw.gangNames && typeof raw.gangNames === "object" ? raw.gangNames : {},
      links: raw.links && typeof raw.links === "object" ? raw.links : {},
    };
  } catch {
    return null;
  }
}

async function writeMeta(store: Ephemeral, meta: MetaCache): Promise<void> {
  try {
    await store.put(META_KEY, meta, KEEP_SEC);
  } catch {
    /* a missed write only repeats the daily list */
  }
}

async function readStatus(store: Ephemeral): Promise<StatusCache | null> {
  try {
    const raw = await store.get<StatusCache>(STATUS_KEY);
    if (!raw?.byId || typeof raw.byId !== "object") return null;
    return { fullAt: Number(raw.fullAt) || 0, byId: raw.byId };
  } catch {
    return null;
  }
}

async function writeStatus(store: Ephemeral, status: StatusCache): Promise<void> {
  try {
    await store.put(STATUS_KEY, status, KEEP_SEC);
  } catch {
    /* the next view may repeat one batch */
  }
}

function namesEqual(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

async function linkAirConditioners(client: TuyaClient, devices: TuyaDevice[]): Promise<Map<string, { infraredId?: string; remoteId?: string }>> {
  const links = new Map<string, { infraredId?: string; remoteId?: string }>();
  const irs = devices.filter((device) => device.category === "wnykq");
  const remotes = new Map<string, { remote_id?: string; remote_name?: string }[]>();
  for (const ir of irs) {
    try {
      remotes.set(ir.id, await client.listRemotes(ir.id));
    } catch (err) {
      if (isQuotaError(err)) throw err;
      remotes.set(ir.id, []);
    }
  }
  for (const device of devices) {
    if (device.category !== "qt") continue;
    const gateway = device.gatewayId || device.gateway_id || device.parentId || device.parent_id;
    if (gateway) {
      links.set(device.id, { infraredId: String(gateway), remoteId: String(device.nodeId || device.node_id || device.id) });
      continue;
    }
    let found = false;
    for (const [irId, list] of remotes) {
      const hit = list.find((remote) => remote.remote_id === device.id || (remote.remote_name && namesEqual(remote.remote_name, deviceTitle(device))));
      if (hit?.remote_id) {
        links.set(device.id, { infraredId: irId, remoteId: hit.remote_id });
        found = true;
        break;
      }
    }
    if (found) continue;
    const byName = irs.find((ir) => namesEqual(deviceTitle(ir), deviceTitle(device)));
    if (byName) links.set(device.id, { infraredId: byName.id, remoteId: device.id });
  }
  return links;
}
