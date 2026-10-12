import { HYDRO_UNAVAILABLE, readHydrawise, zonesFromCache } from "./hydro-cache";
import { controllerNote } from "./hydrawise";
import { applyPrefs, loadPrefs } from "./prefs";
import { catalogItemFromDevice, deviceTitle, presentDevice } from "./present";
import { jerusalemLabel } from "./time";
import { TuyaClient } from "./tuya";
import type { CatalogItem, DeviceView, Env, SectionId, SectionView, Snapshot, TuyaDevice, ZoneView } from "./types";

const SECTION_META: Record<SectionId, { icon: string; title: string }> = {
  garden: { icon: "🌱", title: "גינה והשקיה" },
  climate: { icon: "🌡️", title: "אקלים" },
  lights: { icon: "💡", title: "תאורה ומתגים" },
  curtains: { icon: "🪟", title: "תריסים" },
  power: { icon: "⚡", title: "חשמל ודוד" },
  other: { icon: "🧩", title: "אחר" },
};

const ORDER: SectionId[] = ["garden", "climate", "lights", "curtains", "power", "other"];
const CACHE_MS = 20_000;
/** Full Tuya status sweep. fresh=1 does not bypass this. */
export const TUYA_MIN_MS = 60_000;
const TUYA_KEY = "tuya_devices";

let memory: { at: number; data: Snapshot } | null = null;

export async function invalidateSnapshot(kv?: Pick<KVNamespace, "delete">): Promise<void> {
  memory = null;
  try {
    await kv?.delete("snapshot_cache");
  } catch {
    /* the short assembly cache expires on its own */
  }
}

export function groupSnapshot(input: {
  devices: DeviceView[];
  zones: ZoneView[];
  controllerName: string;
  controllerNote: string;
  errors: string[];
  now: Date;
}): Snapshot {
  const buckets = new Map<SectionId, DeviceView[]>();
  for (const id of ORDER) buckets.set(id, []);
  for (const d of input.devices) buckets.get(d.section)?.push(d);
  const sections: SectionView[] = [];
  for (const id of ORDER) {
    const devices = (buckets.get(id) || []).slice().sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name, "he"));
    const zones = id === "garden" ? input.zones : [];
    if (!devices.length && !zones.length) continue;
    const meta = SECTION_META[id];
    sections.push({
      id,
      icon: meta.icon,
      title: meta.title,
      subtitle: id === "garden" ? `בקר ${input.controllerName}${input.controllerNote ? " · " + input.controllerNote : ""}` : id === "climate" ? "מזגנים ושלטי IR" : undefined,
      online: devices.filter((d) => d.online).length,
      total: devices.length,
      devices,
      zones,
    });
  }
  const online = input.devices.filter((d) => d.online).length;
  const catalog: CatalogItem[] = [
    ...input.zones.filter((z) => z.relayId != null).map((z) => ({
      kind: "zone" as const,
      id: `zone-${z.relayId}`,
      name: z.name,
      category: "zone",
      section: "zone" as const,
      relayId: z.relayId ?? undefined,
    })),
    ...input.devices.map(catalogItemFromDevice),
  ];
  return {
    updatedAt: input.now.toISOString(),
    updatedLabel: `${jerusalemLabel(input.now)} (שעון ישראל)`,
    stats: {
      devices: input.devices.length,
      online,
      offline: input.devices.length - online,
      zones: input.zones.length,
    },
    controller: { name: input.controllerName, note: input.controllerNote },
    sections,
    errors: input.errors,
    catalog,
  };
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

function namesEqual(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export async function buildSnapshot(env: Env, opts?: { fresh?: boolean; now?: Date; client?: TuyaClient }): Promise<Snapshot> {
  const raw = await loadRawSnapshot(env, opts);
  try {
    return applyPrefs(raw, await loadPrefs(env.RULES));
  } catch {
    return raw;
  }
}

async function loadRawSnapshot(env: Env, opts?: { fresh?: boolean; now?: Date; client?: TuyaClient }): Promise<Snapshot> {
  if (!opts?.fresh && memory && Date.now() - memory.at < CACHE_MS) return memory.data;
  if (!opts?.fresh) {
    try {
      const cached = await env.RULES.get("snapshot_cache", "json") as { at?: number; data?: Snapshot } | null;
      if (cached?.data && cached.at && Date.now() - cached.at < CACHE_MS) {
        memory = { at: cached.at, data: cached.data };
        return cached.data;
      }
    } catch {
      /* KV miss is fine */
    }
  }
  const data = await buildFresh(env, opts?.now ?? new Date(), opts?.client);
  memory = { at: Date.now(), data };
  try {
    await env.RULES.put("snapshot_cache", JSON.stringify({ at: Date.now(), data }), { expirationTtl: 60 });
  } catch {
    /* cache is optional */
  }
  return data;
}

async function buildFresh(env: Env, now: Date, existing?: TuyaClient): Promise<Snapshot> {
  const errors: string[] = [];
  const hydro = await readHydrawise(env.RULES, env.HYDRAWISE_API_KEY || "", now.getTime());
  const zones = zonesFromCache(hydro, now);
  const controllerName = String(hydro.controller.name || "Hydrawise");
  const note = controllerNote(hydro.controller, hydro.schedule || {}, now);
  if (!zones.length && hydro.error) errors.push(HYDRO_UNAVAILABLE);

  const tuya = await loadTuya(env, now, existing);
  errors.push(...tuya.errors);
  return groupSnapshot({ devices: tuya.devices, zones, controllerName, controllerNote: note, errors, now });
}

type TuyaCache = { fetchedAt: number; devices: DeviceView[] };

async function loadTuya(env: Env, now: Date, existing?: TuyaClient): Promise<{ devices: DeviceView[]; errors: string[] }> {
  let cached: TuyaCache | null = null;
  try {
    const raw = await env.RULES.get(TUYA_KEY, "json") as TuyaCache | null;
    if (raw?.devices && Array.isArray(raw.devices)) cached = { fetchedAt: Number(raw.fetchedAt) || 0, devices: raw.devices };
  } catch {
    cached = null;
  }
  if (cached && now.getTime() - cached.fetchedAt < TUYA_MIN_MS) return { devices: cached.devices, errors: [] };
  try {
    await env.RULES.put(TUYA_KEY, JSON.stringify({ fetchedAt: now.getTime(), devices: cached?.devices || [] }));
  } catch {
    /* claim is best-effort */
  }
  try {
    const loaded = await fetchPresented(env, now, existing);
    try {
      await env.RULES.put(TUYA_KEY, JSON.stringify({ fetchedAt: now.getTime(), devices: loaded.devices }));
    } catch {
      /* next call may repeat the sweep */
    }
    return loaded;
  } catch (err) {
    if (cached?.devices.length) return { devices: cached.devices, errors: ["Tuya לא רוענן, מוצג המצב האחרון."] };
    return { devices: [], errors: [`Tuya: ${err instanceof Error ? err.message : "שגיאה"}`] };
  }
}

async function fetchPresented(env: Env, now: Date, existing?: TuyaClient): Promise<{ devices: DeviceView[]; errors: string[] }> {
  const errors: string[] = [];
  const client = existing || new TuyaClient({
    accessId: env.TUYA_ACCESS_ID,
    accessSecret: env.TUYA_ACCESS_SECRET,
    base: env.TUYA_BASE,
  });
  const raw = (await client.listDevices()) as TuyaDevice[];
  const links = await linkAirConditioners(client, raw);
  const devices = await mapPool(raw, 5, async (d) => {
    let status: Record<string, unknown> | null = null;
    let names: Record<string, string> = {};
    try {
      status = await client.deviceStatus(d.id);
    } catch (err) {
      errors.push(`${deviceTitle(d)}: ${err instanceof Error ? err.message : "סטטוס"}`);
    }
    if (status && (d.category === "kg" || d.category === "tgkg")) names = await client.gangNames(d.id);
    return presentDevice(d, status, names, now, links.get(d.id));
  });
  return { devices, errors };
}

async function linkAirConditioners(client: TuyaClient, devices: TuyaDevice[]): Promise<Map<string, { infraredId?: string; remoteId?: string }>> {
  const links = new Map<string, { infraredId?: string; remoteId?: string }>();
  const irs = devices.filter((d) => d.category === "wnykq");
  const remotes = new Map<string, { remote_id?: string; remote_name?: string }[]>();
  await mapPool(irs, 3, async (ir) => {
    try {
      remotes.set(ir.id, await client.listRemotes(ir.id));
    } catch {
      remotes.set(ir.id, []);
    }
  });
  for (const d of devices) {
    if (d.category !== "qt") continue;
    const gateway = d.gatewayId || d.gateway_id || d.parentId || d.parent_id;
    if (gateway) {
      links.set(d.id, { infraredId: String(gateway), remoteId: String(d.nodeId || d.node_id || d.id) });
      continue;
    }
    let found = false;
    for (const [irId, list] of remotes) {
      const hit = list.find((r) => r.remote_id === d.id || (r.remote_name && namesEqual(r.remote_name, deviceTitle(d))));
      if (hit?.remote_id) {
        links.set(d.id, { infraredId: irId, remoteId: hit.remote_id });
        found = true;
        break;
      }
    }
    if (found) continue;
    const byName = irs.find((ir) => namesEqual(deviceTitle(ir), deviceTitle(d)));
    if (byName) links.set(d.id, { infraredId: byName.id, remoteId: d.id });
  }
  return links;
}
